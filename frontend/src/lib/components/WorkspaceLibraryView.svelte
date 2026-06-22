<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { _ } from "$lib/i18n";
	import {
		thumbnailUrl as buildThumbnailUrl,
		renameProjectStory,
		deleteProject as deleteProjectApi,
	} from "$lib/api/client.js";
	import { signedAssetSrc, type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";
	import { buildWorkspaceHref } from "$lib/navigation/workspace-routes.js";
	import { queueWorkspaceNavigation } from "$lib/navigation/workspace-navigation.js";
	import {
		buildTaskFocusQueue,
		type TaskFocusItem,
	} from "$lib/project/task-focus-queue.js";
	import { workInboxTitle } from "$lib/project/work-inbox-copy.js";
	import { isLikelyServedProjectImageId } from "$lib/project/page-thumbnails.js";
	import {
		buildWorkspaceJobLanes,
		buildWorkspaceProjectBrowser,
		getWorkspaceProjectDeleteConfirmTitle,
		groupChaptersByNumber,
		type WorkspaceChapterNumberGroup,
		type WorkspaceJobLane,
		type WorkspaceProjectBrowserChapter,
		type WorkspaceProjectBrowserGroup,
		type WorkspaceProjectLanguageSummary,
		type WorkspaceProjectWorkState,
	} from "$lib/project/workspace-dashboard.js";
	import { findStoryGroupByTitleKey } from "$lib/project/story-id.js";
	import { formatLangCode } from "$lib/project/language-display.ts";
	import { listRecentProjectImageAssets, type ProjectImageAssetSummary } from "$lib/api/client.js";
	import { resolveVisiblePageLayerCount, summarizePageWork, type PageWorkSummary } from "$lib/project/page-work-summary.js";
	import { chapterLaneProgressPercent, type ChapterPipelineLane } from "$lib/project/chapter-pipeline.js";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import {
		editorUiStore,
		type ChapterSetupCompletionView,
	} from "$lib/stores/editor-ui.svelte.ts";
	import { effectiveTeamMode } from "$lib/stores/workspace-team-mode.ts";
	import { canUseBackendProjectEndpoints, projectStore } from "$lib/stores/project.svelte.ts";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
	import { formatRecentProjectUpdatedAt } from "$lib/project/recent-projects.js";
	import { chapterLabelPrefix } from "$lib/i18n";
	import PendingInvitesPanel from "./PendingInvitesPanel.svelte";
	import WorkspaceTopUtilityBar from "./WorkspaceTopUtilityBar.svelte";
	import RoleBadge, { type WorkRole, type RoleState } from "./ui/RoleBadge.svelte";
	import { type StatTone } from "./ui/StatTile.svelte";
	import { type LanguagePair } from "./ui/LanguageCoverageChips.svelte";
	import {
		type ChapterLangProgress,
		type ChapterRoleBadge,
		type ChapterRowCount,
	} from "./ui/ChapterRow.svelte";
	import ModeToggle from "./ui/ModeToggle.svelte";
	import WorkspacePageHeader from "./ui/WorkspacePageHeader.svelte";
	import Chip from "./ui/Chip.svelte";
	import StorySettingsDialog from "./workspace/library/StorySettingsDialog.svelte";
	import LibraryShelf, { type LibraryTitleCardView } from "./workspace/library/LibraryShelf.svelte";
	import LibraryEmptyShelf from "./workspace/library/LibraryEmptyShelf.svelte";
	import StoryChapterBoard, { type StoryChapterRowView } from "./workspace/library/StoryChapterBoard.svelte";
	import StorySideRail from "./workspace/library/StorySideRail.svelte";
	import ChapterPacketPanel, { type PacketReviewCommand } from "./workspace/library/ChapterPacketPanel.svelte";
	import StoryStageHeader, {
		type LanguageProgressCardView,
		type LanguageButtonView,
	} from "./workspace/library/StoryStageHeader.svelte";

	type ChapterReviewCommandTone = "hot" | "warn" | "ready" | "idle";
	type ChapterReviewFilter = "comments" | "ai-qc" | "review" | "blockers";
	type ChapterSetupAction = "pages" | "import" | "work";
	type ChapterSetupTone = "hot" | "warn" | "ready" | "idle";

	interface ChapterReviewCommand {
		id: string;
		label: string;
		count: number;
		detail: string;
		tone: ChapterReviewCommandTone;
		item: TaskFocusItem | null;
		filter: ChapterReviewFilter;
	}

	interface ChapterSetupStep {
		id: string;
		label: string;
		value: string;
		detail: string;
		tone: ChapterSetupTone;
		action: ChapterSetupAction;
		actionLabel: string;
	}

	type LibraryHomeTab = "all" | "solo" | "team" | "urgent" | "deadline" | "assigned" | "review";
	type LibrarySearchResult = { id: string; type: string; title: string; subtitle: string; detail: string; accent: "cyan" | "violet"; open: () => void };
	type LibraryHomeFilter = "all" | "attention" | "active" | "ready" | "setup";
	type LibraryHomeSort = "latest" | "attention" | "progress";
	type LibraryProjectViewMode = "grid" | "list";
	type StoryPipelineLane = "script" | "clean" | "translate" | "typeset" | "qc" | "done";
	type LibraryFocusChapter = {
		title: WorkspaceProjectBrowserGroup;
		chapter: WorkspaceProjectBrowserChapter;
	};

	let LIBRARY_HOME_TABS = $derived<readonly { id: LibraryHomeTab; label: string; counted?: boolean }[]>([
		{ id: "all", label: $_("library.tabAll") },
		{ id: "solo", label: $_("library.tabSolo") },
		{ id: "team", label: $_("library.tabTeam") },
		{ id: "urgent", label: $_("library.tabUrgent"), counted: true },
		{ id: "deadline", label: $_("library.tabDeadline"), counted: true },
		{ id: "assigned", label: $_("library.tabAssigned") },
		{ id: "review", label: $_("library.tabReview") },
	]);

	const STORY_PIPELINE_LANES: readonly { id: StoryPipelineLane; label: string; accent: string }[] = [
		{ id: "script", label: "SCRIPT", accent: "teal" },
		{ id: "clean", label: "CLEAN", accent: "cyan" },
		{ id: "translate", label: "TRANSLATE", accent: "blue" },
		{ id: "typeset", label: "TYPESET", accent: "violet" },
		{ id: "qc", label: "QC", accent: "amber" },
		{ id: "done", label: "DONE", accent: "green" },
	] as const;
	const STORY_CHAPTER_PAGE_SIZE = 8;

	// `getWorkspaceProjectFamilyName` now returns "" for an unnamed story (instead of a
	// rendered Thai string); localize the empty display title here so non-Thai locales
	// show "Untitled story". The group `id`/`storyId` (used for keys, URLs, grouping)
	// stay locale-independent — only the human-visible `title` is localized.
	let projectBrowserGroups = $derived(
		buildWorkspaceProjectBrowser(projectStore.recentProjects, 24, 100, $chapterLabelPrefix).map((group) =>
			group.title.trim() ? group : { ...group, title: $_("library.untitledStory") },
		),
	);
	let titleCoverFailures = $state<Record<string, boolean>>({});
	let loadingActiveChapterId = $state<string | null>(null);
	let librarySearchQuery = $state("");
	let libraryHomeTab = $state<LibraryHomeTab>("all");
	let libraryHomeFilter = $state<LibraryHomeFilter>("all");
	let libraryHomeSort = $state<LibraryHomeSort>("latest");
	let libraryProjectViewMode = $state<LibraryProjectViewMode>("grid");
	let storyChapterPage = $state(1);
	// Chapter-list language filter (issue #14c): null = all languages.
	let chapterLangFilter = $state<string | null>(null);
	let storySettingsOpen = $state(false);
	// First cold load only: kept true from the moment the library mounts until the very
	// first recent-projects fetch resolves, so we show a loading skeleton instead of
	// flashing the empty-workspace shelf. Starts false when the store already has data or
	// has already errored (a background refresh then keeps the current view rather than
	// re-skeletoning it — matches the "don't own the viewport" contract).
	let initialLibraryLoadPending = $state(
		projectStore.recentProjects.length === 0 && !projectStore.recentProjectsError,
	);
	type StoryDetailTab = "overview" | "notes" | "files" | "ai" | "history";
	let storyDetailTab = $state<StoryDetailTab>("overview");
	let storyDetailTabs = $derived<readonly { id: StoryDetailTab; label: string; emptyText: string }[]>([
		{ id: "overview", label: $_("library.detailTabOverview"), emptyText: "" },
		{ id: "notes", label: $_("library.detailTabNotes"), emptyText: $_("library.detailTabNotesEmpty") },
		{ id: "files", label: $_("library.detailTabFiles"), emptyText: $_("library.detailTabFilesEmpty") },
		{ id: "ai", label: "AI Check", emptyText: $_("library.detailTabAiEmpty") },
		{ id: "history", label: $_("library.detailTabHistory"), emptyText: $_("library.detailTabHistoryEmpty") },
	]);
	let activeStoryDetailTab = $derived(
		storyDetailTabs.find((tab) => tab.id === storyDetailTab) ?? storyDetailTabs[0],
	);
	let libraryShellEl = $state<HTMLElement | null>(null);
	let lastLibraryPathname = $state("");

	// The "chapter opened from a local summary only" state is now matched on the
	// stable `summary_only_loaded` status code (set by WorkspaceShell), so this view
	// no longer needs the rendered-Thai sentinel string it used to `===`-compare.

	let currentPathname = $derived(resolveCurrentPathname());
	let selectedTitle = $derived(resolveSelectedTitle());
	// Story-overview panels (#14d): wire the summary / AI Check / history tabs to the
	// data the story group ALREADY carries (no fabrication, no per-chapter state load).
	// The chapters of the selected story, most-recently-updated first (the "recent
	// activity" feed the summary + history panels show).
	let storyRecentChapters = $derived(
		[...(selectedTitle?.chapters ?? [])]
			.sort((a, b) => new Date(b.project.updatedAt).getTime() - new Date(a.project.updatedAt).getTime())
			.slice(0, 6),
	);
	// Chapters with something to AI-check / review (real per-chapter review+comment
	// counts the board already computes), most-loaded first.
	let storyAiCheckChapters = $derived(
		(selectedTitle?.chapters ?? [])
			.filter((chapter) => chapter.reviewCount > 0 || chapter.commentCount > 0)
			.sort((a, b) => (b.reviewCount + b.commentCount) - (a.reviewCount + a.commentCount))
			.slice(0, 8),
	);
	// Latest uploaded files for the story (#14d): lazily fetch ONE bounded page of
	// the most-recently-updated chapter's assets (newest-first server order) and
	// show the human uploads. Guarded so it fetches once per story; failures are
	// silent (the panel falls back to its honest empty state).
	let storyLatestFiles = $state<ProjectImageAssetSummary[]>([]);
	let storyLatestFilesFor = $state<string | null>(null);
	$effect(() => {
		const story = selectedTitle;
		const newestChapter = storyRecentChapters[0];
		if (!story || !newestChapter || !canUseBackendProjectEndpoints) return;
		if (storyLatestFilesFor === story.id) return;
		storyLatestFilesFor = story.id;
		storyLatestFiles = [];
		const projectId = newestChapter.project.projectId;
		void listRecentProjectImageAssets(projectId, 12)
			.then((assets) => {
				if (storyLatestFilesFor !== story.id) return; // a newer story won the race
				storyLatestFiles = assets
					.filter((asset) => asset.uploadedBy?.source !== "ai_job")
					.slice(0, 5);
			})
			.catch(() => {/* honest empty state */});
	});
	let libraryHomeMode = $derived(currentPathname === "/" || currentPathname === "/library");
	// Show the loading skeleton only on a genuine first cold load (no titles yet, no prior
	// error). recentProjectsLoading covers an explicit foreground refresh.
	let showLibraryLoadingSkeleton = $derived(
		libraryHomeMode
			&& projectBrowserGroups.length === 0
			&& !projectStore.recentProjectsError
			&& (projectStore.recentProjectsLoading || initialLibraryLoadPending),
	);
	let filteredLibraryHomeGroups = $derived(filterLibraryHomeGroups());
	let normalizedLibrarySearch = $derived(normalizeLibrarySearch(librarySearchQuery));
	let librarySearchResults = $derived.by(() => {
		if (!normalizedLibrarySearch) return [] as LibrarySearchResult[];
		const results: LibrarySearchResult[] = [];
		for (const group of projectBrowserGroups) {
			if (libraryGroupSearchText(group).includes(normalizedLibrarySearch)) {
				results.push({
					id: `story-${group.id}`,
					type: $_("library.searchTypeStory"),
					title: group.title,
					subtitle: $_("library.searchStorySubtitle", { values: { chapters: group.chapterCount, pages: group.totalPages, langs: group.targetLangs.map((lang) => formatLangCode(lang)).join(", ") || $_("library.noLanguageYet") } }),
					detail: $_("library.searchOpenStory"),
					accent: "cyan",
					open: () => selectTitle(group.id),
				});
			}
			for (const chapter of group.chapters) {
				const chapterText = `${group.title} ${chapter.chapterLabel} ${chapter.project.targetLang} ${chapter.project.name}`.toLocaleLowerCase();
				if (chapterText.includes(normalizedLibrarySearch)) {
					results.push({
						id: `chapter-${chapter.project.projectId}`,
						type: $_("library.searchTypeChapter"),
						title: `${group.title} · ${chapter.chapterLabel}`,
						subtitle: $_("library.searchChapterSubtitle", { values: { lang: formatLangCode(chapter.project.targetLang), pages: chapter.project.pageCount } }),
						detail: $_("library.searchOpenChapter"),
						accent: "violet",
						open: () => selectChapter(chapter.project.projectId, group.id),
					});
				}
			}
		}
		return results.slice(0, 24);
	});
	let visibleLibrarySearchResults = $derived(librarySearchResults.slice(0, 6));
	let libraryFocusChapters = $derived(buildLibraryFocusChapters());
	// Chapters filtered by the active language chip, then grouped so chapters that
	// share a number collapse into one row with their language tracks (issue #14c).
	let filteredStoryChapters = $derived<WorkspaceProjectBrowserChapter[]>(
		selectedTitle
			? (chapterLangFilter
				? selectedTitle.chapters.filter((chapter) => chapter.project.targetLang === chapterLangFilter)
				: selectedTitle.chapters)
			: [],
	);
	let allStoryChapterGroups = $derived(groupChaptersByNumber(filteredStoryChapters));
	// Languages to filter by, derived from the chapters ACTUALLY present (their
	// scalar targetLang) — NOT selectedTitle.targetLangs, which can list a track a
	// single multi-track project declares but has no matching chapter row for, so a
	// chip would filter to an empty board.
	let chapterFilterLanguages = $derived<string[]>(
		selectedTitle
			? [...new Set(selectedTitle.chapters.map((chapter) => chapter.project.targetLang).filter(Boolean))]
			: [],
	);
	let storyChapterPageCount = $derived(
		Math.max(1, Math.ceil(allStoryChapterGroups.length / STORY_CHAPTER_PAGE_SIZE)),
	);
	let effectiveStoryChapterPage = $derived(Math.min(storyChapterPage, storyChapterPageCount));
	let storyChapterPageStart = $derived((effectiveStoryChapterPage - 1) * STORY_CHAPTER_PAGE_SIZE);
	let paginatedStoryChapterGroups = $derived(
		allStoryChapterGroups.slice(storyChapterPageStart, storyChapterPageStart + STORY_CHAPTER_PAGE_SIZE),
	);
	let storyChapterPageNumbers = $derived(
		Array.from({ length: storyChapterPageCount }, (_, index) => index + 1)
			.slice(Math.max(0, effectiveStoryChapterPage - 3), Math.min(storyChapterPageCount, effectiveStoryChapterPage + 2)),
	);
	let selectedChapter = $derived(
		selectedTitle?.chapters.find((chapter) => chapter.project.projectId === projectStore.project?.projectId)
			?? null,
	);
	let selectedLanguage = $derived(resolveSelectedLanguage(selectedTitle, selectedChapter));
	let selectedLanguageSummary = $derived(
		selectedTitle?.languageSummaries.find((summary) => summary.lang === selectedLanguage) ?? null,
	);
	let selectedTitleLatestChapter = $derived(selectedTitle ? latestTitleChapter(selectedTitle) : null);
	let selectedLanguageChapter = $derived(resolveLanguageChapter(selectedTitle, selectedChapter, selectedLanguage));
	let selectedLanguageChapters = $derived(
		selectedTitle?.chapters.filter((chapter) => chapter.project.targetLang === selectedLanguage) ?? [],
	);
	let activeStageChapter = $derived(selectedLanguageChapter ?? selectedChapter);
	let languageQueueLeadChapter = $derived(activeStageChapter ?? selectedLanguageChapters[0] ?? null);
	let chapterDetailIntent = $derived(currentPathname.includes("/chapters/"));
	let libraryHeaderSubtitle = $derived(
		selectedTitle && activeStageChapter
			? `${selectedTitle.title} / ${activeStageChapter.chapterLabel} / ${formatLangCode(activeStageChapter.project.targetLang)}`
			: $_("library.headerSubtitlePlaceholder"),
	);
	let primaryActionChapter = $derived(selectedChapter ?? selectedTitleLatestChapter);
	let primaryActionLabel = $derived.by(() => {
		if (selectedChapter) return $_("library.openSelectedChapter", { values: { chapter: selectedChapter.chapterLabel } });
		if (selectedTitleLatestChapter) return $_("library.openLatestChapter", { values: { chapter: selectedTitleLatestChapter.chapterLabel } });
		return $_("library.openChapter");
	});
	let showSummaryOnlyNotice = $derived(shouldShowSummaryOnlyNotice());
	let showMissingTitleNotice = $derived(shouldShowMissingTitleNotice());
	let activeChapterLoaded = $derived(Boolean(
		activeStageChapter
		&& projectStore.project?.projectId === activeStageChapter.project.projectId,
	));
	let activeChapterJobLanes = $derived(activeChapterLoaded ? buildWorkspaceJobLanes(projectStore.tasks) : []);
	let activeChapterPageSummaries = $derived.by(() => buildActiveChapterPageSummaries());
	let activeChapterOpenLaneCount = $derived(activeChapterJobLanes.filter((lane) => lane.openCount > 0).length);
	let activeChapterTaskCount = $derived(activeChapterJobLanes.reduce((total, lane) => total + lane.totalCount, 0));
	let activeChapterDoneCount = $derived(activeChapterJobLanes.reduce((total, lane) => total + lane.doneCount, 0));
	let activeChapterFocusItems = $derived(activeChapterLoaded ? buildTaskFocusQueue(projectStore.workInbox, projectStore.tasks) : []);
	let activeChapterPrimarySetupStepId = $derived(
		activeStageChapter ? primaryChapterSetupStepId(activeStageChapter, activeChapterFocusItems) : null,
	);
	let activeChapterSetupSteps = $derived(
		activeStageChapter
			? orderChapterSetupSteps(buildChapterSetupSteps(activeStageChapter, activeChapterFocusItems), activeChapterPrimarySetupStepId)
			: [],
	);
	let isSoloMode = $derived(editorUiStore.workspaceMode === "solo");
	let workspaceTeamMode = $derived(effectiveTeamMode());
	let isAssignedMode = $derived(effectiveTeamMode() === "assigned");
	// Honest identity/team data: the only names we can show truthfully are the
	// signed-in user and the real workspace member COUNT (member records carry no
	// display names client-side). We NEVER invent teammate names/rosters.
	let selfDisplayName = $derived(authStore.user?.name?.trim() || authStore.user?.email?.trim() || $_("library.you"));
	let selfInitial = $derived(selfDisplayName.charAt(0).toUpperCase() || "U");
	// Whether the current user may shape the CATALOG (create/rename/delete
	// stories + chapters). This must be the WORKSPACE member role — the account
	// role is "editor" for every registered user, so gating on
	// authStore.capabilities let every ลูกทีม see create/delete controls
	// (product decision 2026-06-13: catalog changes are owner/admin-only). The
	// backend manage_projects gate is the real authority; this hides the controls.
	let canManageProjects = $derived(workspacesStore.isAdmin);
	let workspaceMemberCount = $derived(workspacesStore.members.length);
	let workspaceName = $derived(workspacesStore.currentWorkspace?.name?.trim() || "");
	// The RESOLVED current-workspace id the Library must scope its listing to. We read
	// the derived `currentWorkspace` (which falls back to the first workspace once the
	// list loads) rather than the raw persisted id, so a first load with empty
	// localStorage still resolves a concrete workspace once the workspaces store
	// settles — and stays `null` until then, so the Library fetches NOTHING instead of
	// the legacy unscoped (cross-workspace) listing.
	let resolvedWorkspaceId = $derived(workspacesStore.currentWorkspace?.workspaceId ?? null);
	// Map the contributor's WORKSPACE studio role + any series-level (story-assignment)
	// duties to the chapter pipeline-role keys, so the "งานของฉัน" queue shows THEIR real
	// role(s) — not a hard-coded "typeset" (the bug: a translator saw a typeset queue and
	// their own claimed work never appeared). A multi-duty member (translator + typesetter,
	// …) sees chapters where ANY of their duties is the active stage.
	const STUDIO_TO_CHAPTER_ROLE: Record<string, string> = {
		translator: "translate", cleaner: "clean", typesetter: "typeset", qc: "qc",
	};
	let viewerRoleKeys = $derived.by(() => {
		const keys = new Set<string>();
		const studio = projectStore.currentWorkspaceMember?.memberStudioRole;
		const mappedStudio = studio ? STUDIO_TO_CHAPTER_ROLE[studio] : undefined;
		if (mappedStudio) keys.add(mappedStudio);
		for (const role of projectStore.viewerStoryDutyRoles ?? []) {
			const mapped = STUDIO_TO_CHAPTER_ROLE[role];
			if (mapped) keys.add(mapped);
		}
		return keys;
	});
	let assignedRolePrimaryKey = $derived([...viewerRoleKeys][0] ?? "typeset");
	let ASSIGNED_ROLE_LABEL = $derived(
		viewerRoleKeys.size > 1
			? $_("library.myRole")
			: assignedRolePrimaryKey === "translate"
				? $_("library.roleTranslate")
				: assignedRolePrimaryKey === "clean"
					? $_("library.roleClean")
					: assignedRolePrimaryKey === "qc"
						? "QC"
						: $_("library.roleTypeset"),
	);
	let assignedRoleChapters = $derived.by(() => {
		if (!selectedTitle) return [] as WorkspaceProjectBrowserChapter[];
		// Chapters where ANY of the contributor's role(s) is the CURRENT active stage —
		// excludes chapters already past their role (done) and not yet reached (todo), so a
		// member sees only work that is actually theirs now, across all their duties.
		return selectedTitle.chapters.filter((chapter) => {
			const pills = chapterRolePills(chapter);
			return pills.some((pill) => viewerRoleKeys.has(pill.key) && (pill.state === "active" || pill.state === "block"));
		});
	});
	let activeChapterCommentItems = $derived(activeChapterFocusItems.filter((item) => item.kind === "comment"));
	let activeChapterAiQcItems = $derived(activeChapterFocusItems.filter((item) => item.kind === "ai_marker" || item.kind === "qc"));
	let activeChapterReviewItems = $derived(activeChapterFocusItems.filter((item) => item.kind === "review_task" || item.status === "review"));
	let activeChapterBlockerItems = $derived(
		activeChapterFocusItems.filter((item) => item.severity === "error" || item.overdue || item.priority === "urgent"),
	);
	let activeChapterReviewCommands = $derived([
		buildChapterReviewCommand("comments", $_("library.cmdCommentsLabel"), activeChapterCommentItems, $_("library.cmdCommentsActive"), $_("library.cmdCommentsEmpty"), "warn", "comments"),
		buildChapterReviewCommand("ai-qc", $_("library.cmdAiQcLabel"), activeChapterAiQcItems, $_("library.cmdAiQcActive"), $_("library.cmdAiQcEmpty"), "warn", "ai-qc"),
		buildChapterReviewCommand("review", $_("library.cmdReviewLabel"), activeChapterReviewItems, $_("library.cmdReviewActive"), $_("library.cmdReviewEmpty"), "ready", "review"),
		buildChapterReviewCommand("blockers", $_("library.cmdBlockersLabel"), activeChapterBlockerItems, $_("library.cmdBlockersActive"), $_("library.cmdBlockersEmpty"), "hot", "blockers"),
	]);

	onMount(() => {
		// Best-effort real member load so the team count is honest (admin-only endpoint;
		// editors/viewers expectedly 403, so we swallow it and just show the solo state).
		if (workspacesStore.currentWorkspaceId && workspacesStore.membersStatus === "idle") {
			void workspacesStore.listMembers(undefined, { silent: true }).catch(() => {});
		}
	});

	// Gate the FIRST cold Library load on a concrete current workspace resolving.
	// On mount with empty localStorage the workspaces store has not settled yet, so
	// `resolvedWorkspaceId` is null — we must NOT load then, or the store would fall
	// through to the legacy UNSCOPED listing (every workspace's projects merged: a
	// cross-workspace leak). Once a workspace resolves we load ONCE, scoped to it.
	// Switching workspaces is handled by the sidebar (clear + scoped reload), so this
	// effect only owns the initial load and does not re-fire per workspace id.
	let libraryInitialLoadStarted = false;
	$effect(() => {
		const workspaceId = resolvedWorkspaceId;
		if (!workspaceId) {
			// Workspaces store has settled (ready/error) but resolved no workspace —
			// drop the cold-load skeleton so the empty state can show instead of
			// spinning forever waiting for an id that will never arrive.
			if (workspacesStore.status === "ready" || workspacesStore.status === "error") {
				initialLibraryLoadPending = false;
			}
			return;
		}
		if (libraryInitialLoadStarted) return;
		if (projectBrowserGroups.length || projectStore.recentProjectsLoading) {
			libraryInitialLoadStarted = true;
			return;
		}
		libraryInitialLoadStarted = true;
		// Show a skeleton (not the empty shelf) until this first load resolves.
		initialLibraryLoadPending = true;
		void projectStore
			.loadRecentProjects({ background: true, silentFailure: true, workspaceId })
			.finally(() => { initialLibraryLoadPending = false; });
	});

	$effect(() => {
		const pathname = currentPathname;
		if (!libraryShellEl || pathname === lastLibraryPathname) return;
		lastLibraryPathname = pathname;
		requestAnimationFrame(() => {
			libraryShellEl?.scrollTo({ top: 0, left: 0 });
		});
	});

	function buildChapterReviewCommand(
		id: string,
		label: string,
		items: readonly TaskFocusItem[],
		activeDetail: string,
		emptyDetail: string,
		activeTone: ChapterReviewCommandTone,
		filter: ChapterReviewFilter,
	): ChapterReviewCommand {
		return {
			id,
			label,
			count: items.length,
			detail: items.length ? activeDetail : emptyDetail,
			tone: items.length ? activeTone : "idle",
			item: items[0] ?? null,
			filter,
		};
	}

	function openDashboard(): void {
		editorUiStore.openDashboard();
		queueWorkspaceNavigation({ view: "dashboard" });
	}

	function normalizeLibrarySearch(value: string): string {
		return value.trim().toLocaleLowerCase();
	}

	function libraryGroupSearchText(title: WorkspaceProjectBrowserGroup): string {
		return [
			title.title,
			title.targetLangs.join(" "),
			title.chapters.map((chapter) => `${chapter.chapterLabel} ${chapter.project.name} ${chapter.workSignal}`).join(" "),
		].join(" ").toLocaleLowerCase();
	}

	function libraryGroupMatchesTab(title: WorkspaceProjectBrowserGroup): boolean {
		return libraryGroupMatchesSpecificTab(title, libraryHomeTab);
	}

	function libraryGroupMatchesSpecificTab(title: WorkspaceProjectBrowserGroup, tab: LibraryHomeTab): boolean {
		if (tab === "all") return true;
		if (tab === "solo") return title.chapterCount <= 1 && title.targetLangs.length <= 1;
		if (tab === "team") return title.openTasks > 0 || title.reviewTasks > 0 || title.openComments > 0;
		if (tab === "urgent") return title.attentionChapterCount > 0 || title.openComments > 0;
		if (tab === "deadline") return title.openTasks > 0 || title.reviewTasks > 0;
		if (tab === "assigned") return title.activeChapterCount > 0 || title.openTasks > 0;
		if (tab === "review") return title.reviewTasks > 0 || title.chapters.some((chapter) => chapter.workState === "review");
		return true;
	}

	function libraryGroupMatchesFilter(title: WorkspaceProjectBrowserGroup): boolean {
		if (libraryHomeFilter === "all") return true;
		if (libraryHomeFilter === "attention") return title.attentionChapterCount > 0;
		if (libraryHomeFilter === "active") return title.activeChapterCount > 0;
		if (libraryHomeFilter === "ready") return title.readyChapterCount > 0;
		if (libraryHomeFilter === "setup") return title.chapters.some((chapter) => chapter.workState === "setup");
		return true;
	}

	function compareLibraryHomeGroups(a: WorkspaceProjectBrowserGroup, b: WorkspaceProjectBrowserGroup): number {
		if (libraryHomeSort === "attention") {
			const attentionDelta = (b.attentionChapterCount + b.openComments + b.reviewTasks) - (a.attentionChapterCount + a.openComments + a.reviewTasks);
			if (attentionDelta !== 0) return attentionDelta;
		}
		if (libraryHomeSort === "progress") {
			const progressDelta = libraryTitleProgressPercent(b) - libraryTitleProgressPercent(a);
			if (progressDelta !== 0) return progressDelta;
		}
		return b.latestUpdatedAt.localeCompare(a.latestUpdatedAt);
	}

	function filterLibraryHomeGroups(): WorkspaceProjectBrowserGroup[] {
		// The top search drives a results dropdown (like the dashboard), NOT an in-page
		// filter; the shelf list is browsed only via the tab + status/sort controls.
		return projectBrowserGroups
			.filter(libraryGroupMatchesTab)
			.filter(libraryGroupMatchesFilter)
			.sort(compareLibraryHomeGroups);
	}

	function buildLibraryFocusChapters(): LibraryFocusChapter[] {
		return projectBrowserGroups
			.flatMap((title) => title.chapters.map((chapter) => ({ title, chapter })))
			.sort((a, b) => {
				const aScore = (a.chapter.workState === "attention" ? 40 : 0) + a.chapter.reviewCount * 8 + a.chapter.commentCount * 6 + a.chapter.openWorkCount;
				const bScore = (b.chapter.workState === "attention" ? 40 : 0) + b.chapter.reviewCount * 8 + b.chapter.commentCount * 6 + b.chapter.openWorkCount;
				if (aScore !== bScore) return bScore - aScore;
				return b.chapter.project.updatedAt.localeCompare(a.chapter.project.updatedAt);
			})
			.slice(0, 4);
	}

	// HONEST title progress from REAL workflow-task data: the share of this title's
	// tasks that are done. No magic per-state coefficients (that produced a
	// plausible-but-fabricated %). When a title has no tasks yet we return 0
	// (not-started) rather than inventing a number.
	function libraryTitleProgressPercent(title: WorkspaceProjectBrowserGroup): number {
		const total = title.totalTasks;
		if (total <= 0) return 0;
		const done = Math.max(0, total - title.openTasks);
		return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
	}

	function libraryTitleRoleLabel(title: WorkspaceProjectBrowserGroup): string {
		if (title.reviewTasks > 0) return $_("library.roleReviewer");
		if (title.openTasks > 0) return "Typesetter";
		if (title.openComments > 0) return "QC";
		return $_("library.roleAuthor");
	}

	function libraryTitleBadgeLabel(title: WorkspaceProjectBrowserGroup): string {
		if (title.attentionChapterCount > 0 || title.openComments > 0) return $_("library.badgeUrgent");
		if (title.reviewTasks > 0) return $_("library.badgeWaitingReview");
		if (title.activeChapterCount > 0) return $_("library.badgeTeam");
		if (title.readyChapterCount > 0) return $_("library.badgeReady");
		return $_("library.badgeSolo");
	}

	function libraryTabCount(tab: LibraryHomeTab): number {
		return projectBrowserGroups.filter((title) => libraryGroupMatchesSpecificTab(title, tab)).length;
	}

	// HONEST team label: the real workspace name when one exists, otherwise an empty
	// string so callers fall back to the solo/own-work state. We never invent a team name.
	function libraryTeamLabel(): string {
		return workspaceName;
	}

	// Avatars/initials can only honestly represent the signed-in user — member records
	// carry no display names client-side, so we never fabricate a teammate roster.
	function selfAvatarInitials(count = 1): string[] {
		return Array.from({ length: Math.max(1, count) }, () => selfInitial);
	}

	// Source→target language coverage pairs for a title (LanguageCoverageChips).
	function titleLanguagePairs(title: WorkspaceProjectBrowserGroup, limit = 99): LanguagePair[] {
		const source = titleSourceLang(title);
		return title.languageSummaries.slice(0, limit).map((summary) => ({
			from: source,
			to: summary.lang,
			pct: languageCoveragePercent(title, summary),
		}));
	}

	// Per-language progress bars for a chapter row (ChapterRow `langs`). A chapter is a
	// single project on a single Language Track, so we only show its REAL target-language
	// track with its real task-completion %. We never fabricate bars for other languages
	// (no per-chapter, per-language progress source exists) — that was the charCodeAt mock.
	function chapterRowLangProgress(chapter: WorkspaceProjectBrowserChapter): ChapterLangProgress[] {
		const lang = chapter.project.targetLang;
		if (!lang) return [];
		const pct = storyChapterProgress(chapter);
		const tone: ChapterLangProgress["tone"] = pct >= 100 ? "green" : "cyan";
		return [{ lang, pct, tone }];
	}

	// Keep one progress bar per language when a grouped chapter has multiple tracks
	// in the same language (#14c) — ChapterRow keys its {#each} by lang, so a dup
	// language would throw. First track wins.
	function dedupeLangProgress(entries: ChapterLangProgress[]): ChapterLangProgress[] {
		const seen = new Set<string>();
		return entries.filter((entry) => (seen.has(entry.lang) ? false : seen.add(entry.lang) && true));
	}

	// Map the deterministic role pills onto the shared RoleBadge role/state shape.
	function chapterRowRoleBadges(chapter: WorkspaceProjectBrowserChapter): ChapterRoleBadge[] {
		return chapterRolePills(chapter).map((pill) => ({
			role: pill.key as WorkRole,
			state: (pill.state === "block" ? "blocked" : pill.state) as RoleState,
		}));
	}

	// Small per-chapter counts shown at the row tail (ChapterRow `counts`).
	function chapterRowCounts(chapter: WorkspaceProjectBrowserChapter): ChapterRowCount[] {
		return [
			{ label: $_("library.statOpenWork"), value: chapter.openWorkCount, tone: "violet" },
			{ label: $_("library.statReview"), value: chapter.reviewCount, tone: "amber" },
			{ label: $_("library.statComments"), value: chapter.commentCount, tone: "cyan" },
		];
	}

	function chapterRowDue(chapter: WorkspaceProjectBrowserChapter): { label: string; late: boolean } {
		if (chapter.workState === "ready") return { label: $_("library.dueDone"), late: false };
		// No real per-chapter deadline data: show an honest "not set" instead of a
		// fabricated countdown. `late` still reflects the real attention work state.
		return { label: $_("library.dueNotSet"), late: chapter.workState === "attention" };
	}

	// StatTile tone for story/chapter metric cards (maps the bespoke tone strings).
	function statToneFor(tone: string): StatTone {
		if (tone === "cyan") return "cyan";
		if (tone === "blue") return "cyan";
		if (tone === "amber") return "amber";
		if (tone === "violet") return "violet";
		if (tone === "green") return "green";
		if (tone === "rose") return "rose";
		return "neutral";
	}

	// Numeric story stats for the StatTile row (deadline rendered separately as text).
	function storyStatTiles(title: WorkspaceProjectBrowserGroup) {
		return [
			{ id: "chapters", label: $_("library.metricChapters"), value: title.chapterCount, tone: "cyan" as StatTone },
			{ id: "pages", label: $_("library.metricPages"), value: title.totalPages, tone: "cyan" as StatTone },
			{ id: "open", label: $_("library.metricOpenWork"), value: title.openTasks, tone: "amber" as StatTone },
			{ id: "review", label: $_("library.metricReview"), value: title.reviewTasks, tone: "violet" as StatTone },
			{ id: "comments", label: $_("library.metricComments"), value: title.openComments, tone: "neutral" as StatTone },
		];
	}

	function chapterStatTiles(chapter: WorkspaceProjectBrowserChapter) {
		return [
			{ id: "pages", label: $_("library.metricPages"), value: chapter.project.pageCount, tone: "cyan" as StatTone },
			{ id: "layers", label: $_("library.metricTextLayers"), value: chapter.project.textLayerCount, tone: "neutral" as StatTone },
			{ id: "open", label: $_("library.metricOpenWork"), value: chapter.project.openTaskCount ?? chapter.openWorkCount, tone: "amber" as StatTone },
			{ id: "qc", label: $_("library.metricQcItems"), value: chapter.reviewCount + chapter.commentCount, tone: "violet" as StatTone },
		];
	}

	type CoverStatusTone = "violet" | "amber" | "cyan" | "green" | "rose" | "faint";

	// Real source language for a title, read from the project records' sourceLang
	// (ProjectSummary.sourceLang). Falls back to a neutral "ต้นทาง" label rather than a
	// fabricated "JP"/"EN" guess when the backend has not recorded a source language.
	function titleSourceLang(title: WorkspaceProjectBrowserGroup): string {
		const real = title.projects
			.map((project) => project.sourceLang?.trim())
			.find((value) => Boolean(value));
		return real ? formatLangCode(real) : $_("library.sourceLangFallback");
	}

	function dotToneClass(tone: CoverStatusTone): string {
		if (tone === "violet") return "bg-ws-violet";
		if (tone === "amber") return "bg-ws-amber";
		if (tone === "cyan") return "bg-ws-cyan";
		if (tone === "green") return "bg-ws-green";
		if (tone === "rose") return "bg-ws-rose";
		return "bg-ws-faint";
	}

	function fillGradient(tone: CoverStatusTone): string {
		if (tone === "green") return "linear-gradient(90deg,var(--color-ws-green),var(--color-ws-accent))";
		if (tone === "cyan") return "linear-gradient(90deg,var(--color-ws-accent),var(--color-ws-violet))";
		if (tone === "faint") return "var(--color-ws-faint)";
		return "linear-gradient(90deg,var(--color-ws-violet),var(--color-ws-accent))";
	}

	function titleIsComplete(title: WorkspaceProjectBrowserGroup): boolean {
		return title.chapterCount > 0
			&& title.readyChapterCount >= title.chapterCount
			&& title.attentionChapterCount === 0
			&& title.activeChapterCount === 0;
	}

	function inProgressLibraryGroups(): WorkspaceProjectBrowserGroup[] {
		return filteredLibraryHomeGroups.filter((title) => !titleIsComplete(title));
	}

	function completedLibraryGroups(): WorkspaceProjectBrowserGroup[] {
		return filteredLibraryHomeGroups.filter((title) => titleIsComplete(title));
	}

	// Precompute the per-card view-model so LibraryShelf/LibraryTitleCard stay pure:
	// every projectStore-derived value is resolved here, in the orchestrator.
	function buildLibraryTitleCardView(title: WorkspaceProjectBrowserGroup, index: number): LibraryTitleCardView {
		const tone = coverStatusTone(title);
		return {
			title,
			tone,
			progress: libraryTitleProgressPercent(title),
			extra: titleExtraMembers(title),
			coverUrl: titleCoverUrl(title),
			statusLabel: coverStatusLabel(title),
			dotToneClass: dotToneClass(tone),
			chapterLabel: titleShelfChapterLabel(title),
			// Show up to 4 language tracks on the card so a multi-language story
			// surfaces its languages at a glance (issue #14b), not just 2.
			languagePairs: titleLanguagePairs(title, 4),
			progressGradient: fillGradient(coverProgressTone(title)),
			avatarInitials: titleAvatarInitials(title, index),
			relativeUpdate: titleRelativeUpdate(title),
		};
	}

	let inProgressLibraryCardViews = $derived(
		inProgressLibraryGroups().map((title, index) => buildLibraryTitleCardView(title, index)),
	);
	let completedLibraryCardViews = $derived(
		completedLibraryGroups().map((title, index) => buildLibraryTitleCardView(title, index)),
	);
	let libraryLanguageCount = $derived(new Set(projectBrowserGroups.flatMap((title) => title.targetLangs)).size);
	let libraryActiveChapterCount = $derived(
		projectBrowserGroups.reduce((total, title) => total + title.activeChapterCount, 0),
	);

	// Precompute the StoryChapterBoard rows so the composite stays pure: the role/lang
	// derivation + active-row decision (which reads projectStore.project) stay here.
	// Map the chapter review commands to the packet's display shape (count/tone/target
	// + whether a focusable item exists), keeping the underlying command objects
	// addressable by id for the focus/editor callbacks.
	function packetReviewCommandView(command: ChapterReviewCommand): PacketReviewCommand {
		return {
			id: command.id,
			label: command.label,
			count: command.count,
			detail: command.detail,
			tone: command.tone,
			hasItem: Boolean(command.item),
			target: reviewCommandTarget(command),
			editorActionLabel: reviewCommandEditorActionLabel(command),
		};
	}
	let packetReviewCommandViews = $derived(activeChapterReviewCommands.map(packetReviewCommandView));
	let packetActivityCommandViews = $derived(
		activeChapterReviewCommands.filter((command) => command.count > 0).map(packetReviewCommandView),
	);

	function chapterReviewCommandById(id: string): ChapterReviewCommand | undefined {
		return activeChapterReviewCommands.find((command) => command.id === id);
	}

	// Story hero language view-models. Cards mirror the first three language summaries
	// with coverage % + gradient; buttons are the full picker list. All projectStore-
	// derived numbers resolve here so StoryStageHeader stays a pure renderer.
	let storyLanguageProgressCards = $derived<LanguageProgressCardView[]>(
		selectedTitle
			? selectedTitle.languageSummaries.slice(0, 3).map((summary) => {
				const pct = languageCoveragePercent(selectedTitle!, summary);
				return {
					summary,
					pct,
					primary: summary.lang === selectedLanguage,
					fillGradient: fillGradient(coverageTone(pct)),
				};
			})
			: [],
	);
	let storyLanguageButtons = $derived<LanguageButtonView[]>(
		selectedTitle
			? selectedTitle.languageSummaries.map((summary) => ({
				summary,
				active: summary.lang === selectedLanguage,
				attention: summary.openTasks > 0 || summary.reviewTasks > 0 || summary.openComments > 0,
				label: languageCoverageLabel(summary),
			}))
			: [],
	);
	let storyLanguageCommand = $derived(
		selectedLanguageSummary && selectedLanguageChapter && selectedTitle && selectedTitle.languageSummaries.length > 1
			? {
				summary: selectedLanguageSummary,
				chapter: selectedLanguageChapter,
				chaptersCountLabel: $_("library.countChapters", { values: { n: selectedLanguageChapters.length } }),
				pageCountLabel: $_("library.countPages", { values: { n: selectedLanguageSummary.pageCount } }),
				blockedLabel: languageActionBlockedLabel(selectedLanguageChapter),
				editorActionLabel: editorActionLabel(selectedLanguageChapter),
				pagesActionLabel: pagesActionLabel(selectedLanguageChapter),
				workActionLabel: workActionLabel(selectedLanguageChapter),
			}
			: null,
	);
	let storyChapterRail = $derived(
		selectedTitle && selectedTitle.chapters.length > 0 && chapterDetailIntent
			? {
				chapters: selectedTitle.chapters,
				rowLeadLabel: (chapter: WorkspaceProjectBrowserChapter) => chapterRowLeadLabel(chapter),
				nextActionChipLabel: (chapter: WorkspaceProjectBrowserChapter) =>
					chapterNextActionChipLabel(chapter.nextAction),
				ariaLabel: (chapter: WorkspaceProjectBrowserChapter) =>
					$_("library.railSelectAria", { values: { chapter: chapter.chapterLabel, lang: formatLangCode(chapter.project.targetLang), action: chapterNextActionChipLabel(chapter.nextAction) } }),
				stateLabel: (chapter: WorkspaceProjectBrowserChapter) => chapterStateLabel(chapter.workState),
				openStateChipLabel: (chapter: WorkspaceProjectBrowserChapter) => chapterOpenStateChipLabel(chapter),
			}
			: null,
	);

	let storyChapterRowViews = $derived<StoryChapterRowView[]>(
		visibleChapterGroups().map((group, index) => {
			const chapter = group.primary;
			const due = chapterRowDue(chapter);
			return {
				chapter,
				label: $_("library.chapterNumber", { values: { n: storyChapterPageStart + index + 1 } }),
				title: chapter.chapterLabel,
				// One bar per language track of this chapter number (#14c) — a row now
				// shows every language the chapter exists in, not just one. De-dupe by
				// language so two same-language projects under one number (e.g. a
				// re-imported chapter) don't collide on ChapterRow's keyed {#each lang}.
				langs: dedupeLangProgress(group.tracks.flatMap((track) => chapterRowLangProgress(track))),
				roles: chapterRowRoleBadges(chapter),
				revised: chapterDoneBadge(chapter) === "v2",
				due: due.label,
				dueLate: due.late,
				counts: chapterRowCounts(chapter),
				active: group.tracks.some((track) => track.project.projectId === activeStageChapter?.project.projectId),
			};
		}),
	);

	function coverStatusLabel(title: WorkspaceProjectBrowserGroup): string {
		if (titleIsComplete(title)) return $_("library.coverExported");
		if (title.attentionChapterCount > 0 || title.openComments > 0) return $_("library.coverWaitingQc");
		if (title.reviewTasks > 0) return $_("library.coverTypesetting");
		if (title.activeChapterCount > 0) return $_("library.coverTranslating");
		if (title.openTasks > 0) return $_("library.coverCleaning");
		if (title.totalPages > 0) return $_("library.coverAiDraft");
		return $_("library.coverJustStarted");
	}

	function coverStatusTone(title: WorkspaceProjectBrowserGroup): CoverStatusTone {
		if (titleIsComplete(title)) return "green";
		if (title.attentionChapterCount > 0 || title.openComments > 0) return "amber";
		if (title.reviewTasks > 0) return "violet";
		if (title.activeChapterCount > 0) return "cyan";
		if (title.openTasks > 0) return "green";
		if (title.totalPages > 0) return "cyan";
		return "faint";
	}

	function coverProgressTone(title: WorkspaceProjectBrowserGroup): CoverStatusTone {
		const percent = libraryTitleProgressPercent(title);
		if (titleIsComplete(title) || percent >= 96) return "green";
		if (percent <= 12) return "faint";
		if (title.attentionChapterCount > 0 || title.reviewTasks > 0) return "violet";
		return "cyan";
	}

	// HONEST per-language progress from REAL task data: the share of this language
	// track's tasks that are done. No invented "base − pressure×6" coverage math.
	// A language with no tasks yet reads 0 rather than a fabricated percentage.
	function languageCoveragePercent(_title: WorkspaceProjectBrowserGroup, summary: WorkspaceProjectLanguageSummary): number {
		const total = summary.totalTasks;
		if (total <= 0) return 0;
		const done = Math.max(0, total - summary.openTasks);
		return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
	}

	function coverageTone(percent: number): CoverStatusTone {
		if (percent >= 85) return "green";
		if (percent >= 40) return "amber";
		return "faint";
	}

	// Cover-card avatar: only the signed-in user is shown honestly; the "+N" badge
	// reflects the REAL remaining workspace members (when the admin-only member list
	// loaded), never an invented count.
	function titleAvatarInitials(_title: WorkspaceProjectBrowserGroup, _index: number): string[] {
		return selfAvatarInitials(1);
	}

	function titleExtraMembers(_title: WorkspaceProjectBrowserGroup): number {
		return Math.max(0, Math.min(9, workspaceMemberCount - 1));
	}

	// Real relative update time from the title's latest updatedAt (never a fabricated
	// "X นาที / เมื่อวาน" ladder). formatRecentProjectUpdatedAt already prefixes "อัปเดต".
	function titleRelativeUpdate(title: WorkspaceProjectBrowserGroup): string {
		return formatRecentProjectUpdatedAt(title.latestUpdatedAt);
	}

	function storyMetricCards(title: WorkspaceProjectBrowserGroup, includeDeadline = true) {
		const metrics = [
			{ id: "chapters", label: $_("library.metricChapters"), value: title.chapterCount, tone: "cyan" },
			{ id: "pages", label: $_("library.metricPages"), value: title.totalPages, tone: "blue" },
			{ id: "open", label: $_("library.metricOpenWork"), value: title.openTasks, tone: "amber" },
			{ id: "review", label: $_("library.metricReview"), value: title.reviewTasks, tone: "violet" },
		];
		if (!includeDeadline) return metrics;
		// No real deadline source yet → honest "not set" card (was a fabricated date).
		return [
			...metrics,
			{
				id: "deadline",
				label: $_("library.metricDueDate"),
				value: storyDeadlineLabel(title),
				detail: undefined,
				tone: "deadline",
			},
		];
	}

	// HONEST chapter progress from REAL workflow-task data (no hardcoded per-state
	// numbers). A "ready" chapter has tasks/layers but no open/review work → genuinely
	// complete. Otherwise we use the real done-tasks ratio. When the chapter has no
	// tasks yet we return 0 (not-started) rather than fabricating a percentage.
	function storyChapterProgress(chapter: WorkspaceProjectBrowserChapter): number {
		const total = chapter.project.taskCount ?? 0;
		if (total > 0) {
			const open = chapter.project.openTaskCount ?? 0;
			const done = Math.max(0, total - open);
			return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
		}
		// No tasks created yet → only "ready" (export-ready, layers present) reads as
		// complete; everything else is honestly 0% (work has not started).
		return chapter.workState === "ready" ? 100 : 0;
	}

	type RolePillState = "done" | "active" | "block" | "todo";
	type RolePill = { key: string; label: string; state: RolePillState };

	let STORY_ROLE_DEFS = $derived<readonly { key: string; label: string }[]>([
		{ key: "clean", label: $_("library.roleClean") },
		{ key: "translate", label: $_("library.roleTranslate") },
		{ key: "typeset", label: $_("library.roleTypeset") },
		{ key: "qc", label: "QC" },
		{ key: "review", label: $_("library.roleReview") },
	]);

	// Derive a deterministic per-role hand-off state from the chapter work state so the
	// row pills mirror the mockup (done → active → todo, with block on attention).
	function chapterRolePills(chapter: WorkspaceProjectBrowserChapter): RolePill[] {
		const order = STORY_ROLE_DEFS.map((def) => def.key);
		let activeIndex: number;
		if (chapter.workState === "ready") activeIndex = order.length;
		else if (chapter.workState === "review") activeIndex = 3;
		else if (chapter.workState === "attention") activeIndex = 3;
		else if (chapter.workState === "active") activeIndex = 2;
		else activeIndex = chapter.openWorkCount > 0 ? 1 : 0;
		return STORY_ROLE_DEFS.map((def, index) => {
			let state: RolePillState;
			if (index < activeIndex) state = "done";
			else if (index === activeIndex) state = chapter.workState === "attention" ? "block" : "active";
			else state = "todo";
			return { key: def.key, label: def.label, state };
		});
	}

	function rolePillClass(pill: RolePill): string {
		if (pill.state === "done") return "border-ws-green/20 bg-ws-green/10 text-ws-green";
		if (pill.state === "block") return "border-ws-rose/20 bg-ws-rose/10 text-ws-rose";
		if (pill.state === "active") {
			if (pill.key === "translate") return "border-ws-cyan/20 bg-ws-cyan/10 text-ws-cyan";
			if (pill.key === "qc") return "border-ws-amber/20 bg-ws-amber/10 text-ws-amber";
			return "border-ws-violet/25 bg-ws-violet/10 text-ws-violet";
		}
		return "border-ws-line/[0.07] bg-ws-surface2/50 text-ws-faint";
	}

	function rolePillDotClass(pill: RolePill): string {
		if (pill.state === "done") return "bg-ws-green";
		if (pill.state === "block") return "bg-ws-rose";
		if (pill.state === "active") {
			if (pill.key === "translate") return "bg-ws-cyan";
			if (pill.key === "qc") return "bg-ws-amber";
			return "bg-ws-violet";
		}
		return "bg-ws-faint";
	}

	function chapterDoneBadge(chapter: WorkspaceProjectBrowserChapter): "done" | "v2" | null {
		if (chapter.workState === "ready") return "done";
		if (chapter.workState === "review") return "v2";
		return null;
	}

	function visibleChapterGroups(): WorkspaceChapterNumberGroup[] {
		// In assigned mode always show the role-scoped queue (even when empty) — don't fall
		// back to every chapter, which would surface work that isn't the contributor's. The
		// assigned queue stays one row per chapter (it's already role-scoped), so each
		// chapter is its own singleton group.
		if (isAssignedMode) {
			return assignedRoleChapters.map((chapter) => ({
				key: `p:${chapter.project.projectId}`,
				chapterNumber: chapter.project.chapterNumber?.trim() || null,
				primary: chapter,
				tracks: [chapter],
			}));
		}
		return paginatedStoryChapterGroups;
	}

	// Deadlines are not yet a real data source, so every deadline label is an honest
	// "not set" — we never fabricate a date or countdown.
	function storyDeadlineLabel(_title: WorkspaceProjectBrowserGroup): string {
		return $_("library.deadlineNotSet");
	}

	function chapterProgressPercent(chapter: WorkspaceProjectBrowserChapter): number {
		const loadedProgress = activeChapterPageSummaries.length
			? Math.round((activeChapterPageSummaries.filter((summary) => summary.exportReady).length / activeChapterPageSummaries.length) * 100)
			: 0;
		if (loadedProgress > 0) return Math.max(loadedProgress, storyChapterProgress(chapter));
		return storyChapterProgress(chapter);
	}

	function chapterDeadlineDate(_chapter: WorkspaceProjectBrowserChapter): string {
		return $_("library.deadlineNotSet");
	}

	function chapterDeadlineDetail(_chapter: WorkspaceProjectBrowserChapter): string {
		return $_("library.deadlineSetInStorySettings");
	}

	function chapterHeroMetricCards(chapter: WorkspaceProjectBrowserChapter) {
		return [
			{ id: "language", label: $_("library.metricLanguage"), value: formatLangCode(chapter.project.targetLang), tone: "cyan" },
			{ id: "pages", label: $_("library.metricPages"), value: chapter.project.pageCount, tone: "blue" },
			{ id: "open", label: $_("library.metricOpenWork"), value: chapter.project.openTaskCount ?? chapter.openWorkCount, tone: "amber" },
			{ id: "qc", label: $_("library.metricQcItems"), value: chapter.reviewCount + chapter.commentCount, tone: "violet" },
			{
				id: "deadline",
				label: $_("library.metricDueComplete"),
				value: chapterDeadlineDate(chapter),
				detail: chapterDeadlineDetail(chapter),
				tone: "deadline",
			},
		];
	}

	function chapterProductionMetricCards(chapter: WorkspaceProjectBrowserChapter) {
		return [
			{ id: "pages", label: $_("library.metricPages"), value: chapter.project.pageCount, tone: "blue" },
			{ id: "text-layers", label: $_("library.metricTextLayers"), value: chapter.project.textLayerCount, tone: "cyan" },
			{ id: "open", label: $_("library.metricOpenWork"), value: chapter.project.openTaskCount ?? 0, tone: "amber" },
			{ id: "comments", label: $_("library.metricComments"), value: chapter.project.openCommentCount ?? 0, tone: "violet" },
		];
	}

	// Only the signed-in user is shown honestly on the chapter live-team row; we have no
	// per-chapter assignee names to populate a fuller stack without fabricating one.
	function chapterTeamInitials(_chapter: WorkspaceProjectBrowserChapter): string[] {
		return selfAvatarInitials(1);
	}

	function chapterPipelineCount(chapter: WorkspaceProjectBrowserChapter, lane: StoryPipelineLane): number {
		if (!activeChapterLoaded) {
			if (lane === "done") return chapter.workState === "ready" ? 1 : 0;
			if (lane === "qc") return chapter.reviewCount + chapter.commentCount;
			return chapter.openWorkCount > 0 || chapter.project.pageCount > 0 ? 1 : 0;
		}
		if (lane === "script") return Math.max(1, activeChapterPageSummaries.filter((summary) => summary.layerCount > 0 || summary.taskTotalCount > 0).length);
		if (lane === "clean") return Math.max(0, activeChapterPageSummaries.filter((summary) => summary.status !== "empty").length);
		if (lane === "translate") return Math.max(0, activeChapterPageSummaries.filter((summary) => summary.layerCount > 0 || summary.taskOpenCount > 0).length);
		if (lane === "typeset") return Math.max(0, activeChapterPageSummaries.filter((summary) => summary.layerCount > 0).length);
		if (lane === "qc") return activeChapterAiQcItems.length + activeChapterCommentItems.length + activeChapterReviewItems.length;
		if (lane === "done") return activeChapterPageSummaries.filter((summary) => summary.exportReady).length;
		return 0;
	}

	function chapterPipelineProgress(chapter: WorkspaceProjectBrowserChapter, lane: StoryPipelineLane): number {
		if (!activeChapterLoaded || activeChapterPageSummaries.length === 0) {
			// Detail not loaded → no per-lane breakdown exists. Reflect the chapter's REAL
			// overall progress (task-completion %) on every lane instead of fabricating a
			// per-lane gradient. A done chapter reads 100; one with no completed work reads 0.
			if (chapter.workState === "ready") return 100;
			return storyChapterProgress(chapter);
		}
		// Loaded chapter → honest COMPLETION-based progress: each lane reflects work that
		// is genuinely done (export-ready pages, finished tasks of the lane's type, or the
		// present-script signal), never "a task/layer exists ÷ pages". A fresh chapter with
		// no completed work reads 0 on every lane; no fabricated floor or 94% ceiling.
		return chapterLaneProgressPercent({
			lane: lane as ChapterPipelineLane,
			summaries: activeChapterPageSummaries,
			tasks: projectStore.tasks,
		});
	}

	function chapterPipelineStateLabel(chapter: WorkspaceProjectBrowserChapter, lane: StoryPipelineLane): string {
		if (lane === "qc" && chapter.commentCount > 0) return $_("library.pipelineNotes", { values: { n: chapter.commentCount } });
		if (lane === "qc" && chapter.reviewCount > 0) return `${chapter.reviewCount} QC`;
		if (lane === "done") return $_("library.pipelinePages", { values: { n: chapterPipelineCount(chapter, lane) } });
		return $_("library.pipelineTasks", { values: { n: chapterPipelineCount(chapter, lane) } });
	}

	function chapterPipelineCards(chapter: WorkspaceProjectBrowserChapter) {
		return STORY_PIPELINE_LANES.map((lane) => ({
			id: lane.id,
			label: lane.id === "translate" ? "TL / TRANSLATE" : lane.label,
			title: chapterPipelineStateLabel(chapter, lane.id),
			detail: lane.id === "qc" && activeChapterBlockerItems.length > 0
				? `${activeChapterBlockerItems.length} blocker`
				: $_("library.pipelineReadyPercent", { values: { pct: chapterPipelineProgress(chapter, lane.id) } }),
			accent: lane.accent,
			progress: chapterPipelineProgress(chapter, lane.id),
			// No fabricated per-lane assignee avatars — we have no real lane assignments.
			avatars: [] as string[],
			ariaLabel: $_("library.pipelineLaneAria", { values: { lane: lane.label, chapter: chapter.chapterLabel } }),
		}));
	}

	function buildActiveChapterPageSummaries(): PageWorkSummary[] {
		const project = projectStore.project;
		if (!activeChapterLoaded || !project) return [];
		return project.pages.map((page, index) => summarizePageWork({
			page,
			pageIndex: index,
			layerCount: resolveVisiblePageLayerCount(
				page,
				project.currentPage === index,
				editorStore.textLayers.length,
				editorStore.hasImage,
			),
			assetIntegrity: projectStore.getPageAssetIntegrity(index),
			qcIssues: projectStore.qcReport.issues,
			tasks: projectStore.tasks,
			comments: projectStore.comments,
			aiReviewMarkers: projectStore.aiReviewMarkers,
			reviewDecisions: projectStore.reviewDecisions,
			productionMode: project.productionMode ?? "solo",
		}));
	}

	function resolveCurrentPathname(): string {
		// Read the SvelteKit reactive `page` store FIRST so this `$derived` recomputes
		// on every client-side navigation (`goto()` settles `page.url`). The previous
		// code returned a value computed from `window.location.pathname`, which is not a
		// Svelte signal — so when navigation landed on a browser-path branch the derived
		// never re-ran and the library view went stale on route changes.
		const kitPathname = page.url.pathname;
		// `page.url` is authoritative once SvelteKit resolves a real route. Before the
		// router settles it can be the default/empty path; fall back to the live browser
		// pathname (which `goto()` + history updates keep current) for the VALUE, while
		// still depending on `kitPathname` above for the reactive recompute.
		const browserPathname = typeof window !== "undefined" ? window.location.pathname : "";
		const effective = kitPathname && kitPathname !== "/" ? kitPathname : browserPathname || kitPathname;
		if (effective.startsWith("/library") || effective.startsWith("/projects")) return effective;
		// Never fabricate a deeper /chapters/ route from an open project: when the
		// library view owns the screen but the URL has not settled yet, default to the
		// overview instead of flipping a story/overview URL into the chapter packet.
		if (editorUiStore.workspaceView === "library") return "/library";
		return effective;
	}

	function openLibraryHome(): void {
		// Escaping a missing/summary-only title link drops the stale (invalid) title so
		// the overview is not left pointing at a story that does not resolve.
		editorUiStore.openLibrary(null);
		queueWorkspaceNavigation({ view: "library" });
	}

	// Backend chapter projects that make up this story. Summary-only / local debug
	// chapters (non-UUID ids) have no backend rows to rename or delete, so they are
	// excluded from the mutating calls.
	function storyBackendProjectIds(title: WorkspaceProjectBrowserGroup): string[] {
		return title.projects
			.map((project) => project.projectId)
			.filter((projectId) => canUseBackendProjectEndpoints(projectId));
	}

	// Rename a story: update `storyTitle` across every chapter project under the
	// story's stable id. `storyId` is server-preserved so the library URL keeps
	// resolving. Refreshes the library and re-points the open title to the (still
	// stable) story id afterwards. Throws on failure so the dialog shows the error.
	async function handleStoryRename(title: WorkspaceProjectBrowserGroup, nextTitle: string): Promise<void> {
		const trimmed = nextTitle.trim();
		if (!trimmed) throw new Error($_("library.errorTitleRequired"));
		const projectIds = storyBackendProjectIds(title);
		if (projectIds.length === 0) throw new Error($_("library.errorStoryNotSavedRename"));
		// Rename each chapter project. storyId is untouched server-side.
		for (const projectId of projectIds) {
			await renameProjectStory(projectId, trimmed);
		}
		// Keep an open project's in-memory state in sync so the breadcrumb/header reflect
		// the new title immediately without waiting for a reload.
		if (projectStore.project && projectIds.includes(projectStore.project.projectId)) {
			projectStore.project.storyTitle = trimmed;
		}
		await projectStore.loadRecentProjects();
		// The stable story id is unchanged; re-select it so the title view stays open
		// on the renamed story.
		editorUiStore.openLibrary(title.storyId);
	}

	// Delete a story: permanently remove every chapter project under it. Irreversible
	// — the dialog gates this behind a type-to-confirm. On success, refreshes the
	// library and returns to the library home (the story no longer resolves).
	async function handleStoryDelete(title: WorkspaceProjectBrowserGroup): Promise<void> {
		const deletableProjects = title.projects.filter((project) =>
			canUseBackendProjectEndpoints(project.projectId));
		if (deletableProjects.length === 0) throw new Error($_("library.errorStoryNotSavedDelete"));
		// The server confirms each project against its OWN canonical title
		// (`storyTitle ?? name`), NOT the group's family-stripped DISPLAY title. Sending
		// `title.title` here made a no-storyTitle chapter whose name carries a chapter
		// suffix (e.g. "เรื่องเอ - ตอน 1") permanently undeletable — the stripped group
		// title ("เรื่องเอ") never matched the backend's expected full name. The
		// type-to-confirm dialog still gates this on the user typing the displayed group
		// title; only the per-project API echo uses each chapter's canonical title.
		for (const project of deletableProjects) {
			await deleteProjectApi(project.projectId, getWorkspaceProjectDeleteConfirmTitle(project));
		}
		await projectStore.loadRecentProjects();
		// The story no longer resolves; return to the library home and drop the stale
		// title selection so the overview isn't left pointing at a deleted story.
		openLibraryHome();
	}

	function resolveSelectedTitle(): WorkspaceProjectBrowserGroup | null {
		if (editorUiStore.workspaceTitleKey) {
			return findStoryGroupByTitleKey(projectBrowserGroups, (group) => group.storyId, editorUiStore.workspaceTitleKey)
				?? projectBrowserGroups.find((group) => group.projects.some((project) => project.projectId === projectStore.project?.projectId))
				?? null;
		}
		return projectBrowserGroups.find((group) => group.projects.some((project) => project.projectId === projectStore.project?.projectId))
			?? null;
	}

	function selectTitle(titleKey: string): void {
		editorUiStore.openLibrary(titleKey);
		editorUiStore.setWorkspaceLanguageKey(null);
		queueWorkspaceNavigation({ view: "title", titleKey });
	}

	function isSummaryOnlyChapter(projectId: string): boolean {
		return projectStore.statusMsgCode === "summary_only_loaded"
			&& !canUseBackendProjectEndpoints(projectId);
	}

	function blockSummaryOnlyChapter(projectId: string): boolean {
		if (!isSummaryOnlyChapter(projectId)) return false;
		projectStore.setStatusMsg($_("library.openSourceChapterFirstCommand"));
		return true;
	}

	function captureLibrarySelection() {
		return {
			titleKey: editorUiStore.workspaceTitleKey,
			languageKey: editorUiStore.workspaceLanguageKey,
		};
	}

	function restoreLibrarySelection(snapshot: ReturnType<typeof captureLibrarySelection>): void {
		editorUiStore.setWorkspaceTitleKey(snapshot.titleKey);
		editorUiStore.setWorkspaceLanguageKey(snapshot.languageKey);
	}

	async function openProjectOrRestoreSelection(
		projectId: string,
		snapshot: ReturnType<typeof captureLibrarySelection>,
	): Promise<boolean> {
		const opened = await projectStore.openProject(projectId, editorStore.editor);
		if (opened === false) {
			restoreLibrarySelection(snapshot);
			return false;
		}
		return true;
	}

	function shouldShowSummaryOnlyNotice(): boolean {
		if (activeStageChapter && isSummaryOnlyChapter(activeStageChapter.project.projectId)) return true;
		return projectStore.statusMsgCode === "summary_only_loaded"
			&& Boolean(editorUiStore.workspaceTitleKey)
			&& !selectedTitle;
	}

	function shouldShowMissingTitleNotice(): boolean {
		return Boolean(editorUiStore.workspaceTitleKey)
			&& !selectedTitle
			&& !showSummaryOnlyNotice;
	}

	async function selectChapter(projectId: string, titleKey?: string): Promise<void> {
		const snapshot = captureLibrarySelection();
		const nextTitleKey = titleKey ?? selectedTitle?.id ?? null;
		const nextChapter = chapterForProject(projectId, nextTitleKey ?? undefined);
		editorUiStore.openLibrary(nextTitleKey);
		editorUiStore.setWorkspaceLanguageKey(nextChapter?.project.targetLang ?? null);
		if (blockSummaryOnlyChapter(projectId)) return;
		const opened = await openProjectOrRestoreSelection(projectId, snapshot);
		if (!opened) return;
		editorStore.refreshTextLayers();
		queueWorkspaceNavigation({
			view: "chapter",
			titleKey: nextTitleKey ?? undefined,
			projectId,
		});
	}

	async function selectLanguage(language: string): Promise<void> {
		if (!selectedTitle) return;
		editorUiStore.openLibrary(selectedTitle.id);
		editorUiStore.setWorkspaceLanguageKey(language);
		queueWorkspaceNavigation({
			view: "language",
			titleKey: selectedTitle.id,
			language,
		});
	}

	async function loadChapterPacket(chapter: WorkspaceProjectBrowserChapter, titleKey?: string): Promise<void> {
		const snapshot = captureLibrarySelection();
		const nextTitleKey = titleKey ?? selectedTitle?.id ?? null;
		if (nextTitleKey) editorUiStore.setWorkspaceTitleKey(nextTitleKey);
		editorUiStore.setWorkspaceLanguageKey(chapter.project.targetLang);
		if (blockSummaryOnlyChapter(chapter.project.projectId)) return;
		const opened = await openProjectOrRestoreSelection(chapter.project.projectId, snapshot);
		if (!opened) return;
		editorStore.refreshTextLayers();
	}

	async function openChapterEditor(projectId: string, titleKey?: string): Promise<void> {
		const snapshot = captureLibrarySelection();
		const nextTitleKey = titleKey ?? selectedTitle?.id ?? null;
		const nextChapter = chapterForProject(projectId, nextTitleKey ?? undefined);
		if (nextTitleKey) editorUiStore.setWorkspaceTitleKey(nextTitleKey);
		if (nextChapter) editorUiStore.setWorkspaceLanguageKey(nextChapter.project.targetLang);
		if (blockSummaryOnlyChapter(projectId)) return;
		if (nextChapter && chapterNeedsPageSetup(nextChapter)) {
			if (projectStore.project?.projectId !== projectId) {
				const opened = await openProjectOrRestoreSelection(projectId, snapshot);
				if (!opened) return;
			}
			projectStore.setStatusMsg($_("library.chapterNoPagesYet"));
			editorUiStore.openLibrary(nextTitleKey);
			editorUiStore.openChapterSetup({
				mode: "fill-existing-zero-page",
				projectId,
				titleKey: nextTitleKey,
			});
			queueWorkspaceNavigation({ view: "library" });
			return;
		}
		if (projectStore.project?.projectId !== projectId) {
			const opened = await openProjectOrRestoreSelection(projectId, snapshot);
			if (!opened) return;
		}
		if (!projectStore.project?.pages.length) {
			projectStore.setStatusMsg($_("library.chapterNoPagesYet"));
			editorUiStore.openLibrary(nextTitleKey);
			editorUiStore.openChapterSetup({
				mode: "fill-existing-zero-page",
				projectId,
				titleKey: nextTitleKey,
			});
			queueWorkspaceNavigation({ view: "library" });
			return;
		}
		editorStore.refreshTextLayers();
		editorUiStore.openEditor({
			source: "library",
			projectId,
			titleKey: nextTitleKey,
			title: selectedTitle?.title ?? nextChapter?.project.name ?? $_("library.pageTitle"),
			chapterLabel: nextChapter?.chapterLabel ?? projectStore.project?.name ?? $_("library.openedChapter"),
			language: nextChapter?.project.targetLang ?? projectStore.project?.targetLang ?? "th",
			reason: chapterNextActionChipLabel(nextChapter?.nextAction ?? "Continue production jobs"),
		});
		queueWorkspaceNavigation({
			view: "editor",
			projectId,
			pageIndex: projectStore.project?.currentPage ?? 0,
		});
	}

	async function openChapterPages(projectId: string, titleKey?: string): Promise<void> {
		const snapshot = captureLibrarySelection();
		const nextTitleKey = titleKey ?? selectedTitle?.id ?? null;
		const nextChapter = chapterForProject(projectId, nextTitleKey ?? undefined);
		if (nextTitleKey) editorUiStore.setWorkspaceTitleKey(nextTitleKey);
		if (nextChapter) editorUiStore.setWorkspaceLanguageKey(nextChapter.project.targetLang);
		if (blockSummaryOnlyChapter(projectId)) return;
		const opened = await openProjectOrRestoreSelection(projectId, snapshot);
		if (!opened) return;
		editorStore.refreshTextLayers();
		editorUiStore.openPages();
		queueWorkspaceNavigation({
			view: "pages",
			projectId,
		});
	}

	async function openChapterWork(projectId: string, titleKey?: string): Promise<void> {
		const snapshot = captureLibrarySelection();
		const nextTitleKey = titleKey ?? selectedTitle?.id ?? null;
		const nextChapter = chapterForProject(projectId, nextTitleKey ?? undefined);
		if (nextTitleKey) editorUiStore.setWorkspaceTitleKey(nextTitleKey);
		if (nextChapter) editorUiStore.setWorkspaceLanguageKey(nextChapter.project.targetLang);
		if (blockSummaryOnlyChapter(projectId)) return;
		const opened = await openProjectOrRestoreSelection(projectId, snapshot);
		if (!opened) return;
		editorStore.refreshTextLayers();
		editorUiStore.openWorkBoard();
		queueWorkspaceNavigation({
			view: "work",
			projectId,
		});
	}

	async function openChapterImport(projectId: string, titleKey?: string): Promise<void> {
		const snapshot = captureLibrarySelection();
		const nextTitleKey = titleKey ?? selectedTitle?.id ?? null;
		const nextChapter = chapterForProject(projectId, nextTitleKey ?? undefined);
		if (nextTitleKey) editorUiStore.setWorkspaceTitleKey(nextTitleKey);
		if (nextChapter) editorUiStore.setWorkspaceLanguageKey(nextChapter.project.targetLang);
		if (blockSummaryOnlyChapter(projectId)) return;
		const opened = await openProjectOrRestoreSelection(projectId, snapshot);
		if (!opened) return;
		editorStore.refreshTextLayers();
		editorUiStore.openImportReview();
		queueWorkspaceNavigation({
			view: "import",
			projectId,
		});
	}

	// Focus mode was removed; "open the chapter's pending work" now lands on the
	// chapter Work Board (the team task-lane board), which is the workspace-first
	// surface for picking up the next task.
	async function openChapterFocus(projectId: string, titleKey?: string): Promise<void> {
		await openChapterWork(projectId, titleKey);
	}

	async function openChapterLaneFocus(
		chapter: WorkspaceProjectBrowserChapter,
		_lane: WorkspaceJobLane,
		titleKey?: string,
	): Promise<void> {
		await openChapterWork(chapter.project.projectId, titleKey);
	}

	async function openLoadedChapterPage(pageIndex: number): Promise<void> {
		if (!projectStore.project || !activeStageChapter) return;
		if (projectStore.project.currentPage !== pageIndex) {
			const pageOpened = await projectStore.goToPage(pageIndex, editorStore.editor);
			if (!pageOpened) return;
			editorStore.refreshTextLayers();
		}
		await openChapterEditor(projectStore.project.projectId, currentLibraryTitleKey());
	}

	function chapterLaneFocusHref(chapter: WorkspaceProjectBrowserChapter, lane: WorkspaceJobLane): string | null {
		if (!lane.firstOpenTaskId) return null;
		return buildWorkspaceHref({
			view: "work",
			projectId: chapter.project.projectId,
		});
	}

	function absoluteWorkspaceLink(href: string): string {
		if (typeof window === "undefined") return href;
		return new URL(href, window.location.origin).toString();
	}

	async function copyChapterLaneFocusLink(chapter: WorkspaceProjectBrowserChapter, lane: WorkspaceJobLane): Promise<void> {
		const href = chapterLaneFocusHref(chapter, lane);
		if (!href) return;
		const link = absoluteWorkspaceLink(href);
		if (!navigator.clipboard?.writeText) {
			projectStore.setStatusMsg($_("library.reviewLinkStatus", { values: { link } }));
			return;
		}
		try {
			await navigator.clipboard.writeText(link);
			projectStore.setStatusMsg($_("library.reviewLinkCopied"));
		} catch {
			projectStore.setStatusMsg($_("library.reviewLinkStatus", { values: { link } }));
		}
	}

	async function selectChapterFocusItem(item: TaskFocusItem): Promise<boolean> {
		if (!projectStore.project) return false;
		if (item.pageIndex !== undefined && projectStore.project.currentPage !== item.pageIndex) {
			const pageOpened = await projectStore.goToPage(item.pageIndex, editorStore.editor);
			if (!pageOpened) return false;
			editorStore.refreshTextLayers();
		}
		projectStore.selectAiReviewMarker(item.kind === "ai_marker" ? item.sourceId : null);
		projectStore.selectProjectComment(item.kind === "comment" ? item.sourceId : null);
		projectStore.selectWorkflowTask(
			item.kind === "workflow_task" || item.kind === "review_task" ? item.sourceId : null,
		);
		projectStore.selectQcIssue(item.kind === "qc" ? item.sourceId : null);
		editorUiStore.setRightPanelMode("work");
		return true;
	}

	async function focusChapterReviewCommand(command: ChapterReviewCommand): Promise<void> {
		if (!command.item || !projectStore.project) return;
		const selected = await selectChapterFocusItem(command.item);
		if (!selected) return;
		editorUiStore.openEditor();
		queueWorkspaceNavigation({
			view: "editor",
			projectId: projectStore.project.projectId,
			pageIndex: command.item.pageIndex ?? projectStore.project.currentPage,
		});
	}

	async function openChapterReviewCommandInEditor(command: ChapterReviewCommand): Promise<void> {
		if (!command.item || !projectStore.project) return;
		const selected = await selectChapterFocusItem(command.item);
		if (!selected) return;
		editorUiStore.openEditor();
		queueWorkspaceNavigation({
			view: "editor",
			projectId: projectStore.project.projectId,
			pageIndex: command.item.pageIndex ?? projectStore.project.currentPage,
		});
	}

	async function openChapterSetupStep(
		chapter: WorkspaceProjectBrowserChapter,
		step: ChapterSetupStep,
		titleKey?: string,
	): Promise<void> {
		if (step.action === "pages" && chapterNeedsPageSetup(chapter)) {
			await openChapterEditor(chapter.project.projectId, titleKey);
			return;
		}
		if (step.action === "pages") {
			await openChapterPages(chapter.project.projectId, titleKey);
			return;
		}
		if (step.action === "import") {
			await openChapterImport(chapter.project.projectId, titleKey);
			return;
		}
		if (step.action === "work") {
			await openChapterWork(chapter.project.projectId, titleKey);
			return;
		}
		await openChapterFocus(chapter.project.projectId, titleKey);
	}

	async function openSelectedLanguageEditor(language: string): Promise<void> {
		const chapter = chapterForLanguage(language);
		if (!chapter || !selectedTitle) return;
		await openChapterEditor(chapter.project.projectId, selectedTitle.id);
	}

	async function openSelectedLanguagePages(language: string): Promise<void> {
		const chapter = chapterForLanguage(language);
		if (!chapter || !selectedTitle) return;
		await openChapterPages(chapter.project.projectId, selectedTitle.id);
	}

	async function openSelectedLanguageWork(language: string): Promise<void> {
		const chapter = chapterForLanguage(language);
		if (!chapter || !selectedTitle) return;
		await openChapterWork(chapter.project.projectId, selectedTitle.id);
	}

	async function openSelectedLanguageFocus(language: string): Promise<void> {
		const chapter = chapterForLanguage(language);
		if (!chapter || !selectedTitle) return;
		await openChapterFocus(chapter.project.projectId, selectedTitle.id);
	}

	function refreshRecentProjects(): void {
		void projectStore.loadRecentProjects();
	}

	function startNewChapterFromLibrary(completionView?: ChapterSetupCompletionView): void {
		if (selectedTitle && !libraryHomeMode) {
			editorUiStore.openLibrary(selectedTitle.id);
			editorUiStore.openChapterSetup({
				mode: "add-chapter-to-title",
				// Pass the RAW stable story id (not the hybrid `<id>-<slug>` segment) so
				// the new chapter is persisted under the same key and groups with its
				// siblings instead of forming a near-duplicate shelf.
				titleKey: selectedTitle.storyId,
				titleName: selectedTitle.title,
				targetLang: selectedLanguage,
			});
			queueWorkspaceNavigation({ view: "title", titleKey: selectedTitle.id });
			return;
		}
		editorUiStore.openLibrary(null);
		editorUiStore.openChapterSetup({
			mode: "create",
			...(completionView ? { completionView } : {}),
		});
		queueWorkspaceNavigation({ view: "library" });
	}

	// "Add chapter" is ALWAYS scoped to the OPEN story — it must never silently fall
	// through to creating a brand-new STORY (the reported bug: pressing "+ เพิ่มตอน"
	// outside a clear story context created a new story instead of a chapter). Guarded
	// on selectedTitle; the affordance only renders within a story (StoryStageHeader),
	// so a missing title is a safe no-op rather than a surprise new shelf.
	function addChapterToSelectedStory(): void {
		if (!selectedTitle) return;
		editorUiStore.openLibrary(selectedTitle.id);
		editorUiStore.openChapterSetup({
			mode: "add-chapter-to-title",
			titleKey: selectedTitle.storyId,
			titleName: selectedTitle.title,
			targetLang: selectedLanguage,
		});
		queueWorkspaceNavigation({ view: "title", titleKey: selectedTitle.id });
	}

	function coverFallbackLabel(title: WorkspaceProjectBrowserGroup): string {
		return title.title
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? "")
			.join("") || "CH";
	}

	function titleCoverKey(title: WorkspaceProjectBrowserGroup): string {
		return `${title.coverProjectId ?? "none"}:${title.coverImageId ?? "none"}`;
	}

	function titleCoverUrl(title: WorkspaceProjectBrowserGroup): string | null {
		if (!title.coverProjectId || !title.coverImageId) return null;
		if (!isLikelyServedProjectImageId(title.coverImageId)) return null;
		if (titleCoverFailures[titleCoverKey(title)]) return null;
		return buildThumbnailUrl(title.coverProjectId, title.coverImageId, 240, 340);
	}

	// Action params for an authed cover <img>: the bare thumbnail URL plus asset
	// identity so signedAssetSrc can attach a signed assetToken (browser <img> has
	// no Bearer header). Null when no servable cover.
	function titleCoverParams(title: WorkspaceProjectBrowserGroup): SignedAssetSrcParams | null {
		const url = titleCoverUrl(title);
		if (!url || !title.coverProjectId || !title.coverImageId) return null;
		return {
			projectId: title.coverProjectId,
			imageId: title.coverImageId,
			url,
			purpose: "thumbnail",
		};
	}

	function currentLibraryTitleKey(): string | undefined {
		return currentRouteLibraryTitleKey() ?? editorUiStore.workspaceTitleKey ?? selectedTitle?.id ?? undefined;
	}

	function currentRouteLibraryTitleKey(): string | undefined {
		if (typeof window === "undefined") return undefined;
		const match = window.location.pathname.match(/^\/library\/([^/]+)/);
		return match?.[1] ? decodeURIComponent(match[1]) : undefined;
	}

	function markTitleCoverFailed(title: WorkspaceProjectBrowserGroup): void {
		titleCoverFailures = { ...titleCoverFailures, [titleCoverKey(title)]: true };
	}

	function clearTitleCoverFailure(title: WorkspaceProjectBrowserGroup): void {
		const key = titleCoverKey(title);
		if (!titleCoverFailures[key]) return;
		const nextFailures = { ...titleCoverFailures };
		delete nextFailures[key];
		titleCoverFailures = nextFailures;
	}

	function pluralize(value: number, singular: string, plural = `${singular}s`): string {
		return `${value} ${value === 1 ? singular : plural}`;
	}

	function countLabel(value: number, label: string): string {
		return `${value} ${label}`;
	}


	function languageCoverageLabel(summary: WorkspaceProjectLanguageSummary): string {
		const signals = [
			summary.openTasks ? $_("library.countOpenWork", { values: { n: summary.openTasks } }) : "",
			summary.reviewTasks ? $_("library.countReview", { values: { n: summary.reviewTasks } }) : "",
			summary.openComments ? $_("library.countComments", { values: { n: summary.openComments } }) : "",
		].filter(Boolean);
		return [
			formatLangCode(summary.lang),
			$_("library.countChapters", { values: { n: summary.chapterCount } }),
			$_("library.countPages", { values: { n: summary.pageCount } }),
			...signals,
		].join(" / ");
	}

	function resolveSelectedLanguage(
		title: WorkspaceProjectBrowserGroup | null,
		chapter: WorkspaceProjectBrowserChapter | null,
	): string | null {
		const routeLanguage = editorUiStore.workspaceLanguageKey;
		if (routeLanguage && title?.languageSummaries.some((summary) => summary.lang === routeLanguage)) {
			return routeLanguage;
		}
		return chapter?.project.targetLang ?? title?.languageSummaries[0]?.lang ?? null;
	}

	function resolveLanguageChapter(
		title: WorkspaceProjectBrowserGroup | null,
		chapter: WorkspaceProjectBrowserChapter | null,
		language: string | null,
	): WorkspaceProjectBrowserChapter | null {
		if (!title || !language) return null;
		if (chapter?.project.targetLang === language) return chapter;
		if (editorUiStore.workspaceLanguageKey === language) {
			return title.chapters.find((candidate) => candidate.project.targetLang === language) ?? null;
		}
		return null;
	}

	function chapterForProject(projectId: string, titleKey?: string): WorkspaceProjectBrowserChapter | null {
		const title = titleKey
			? findStoryGroupByTitleKey(projectBrowserGroups, (group) => group.storyId, titleKey) ?? selectedTitle
			: selectedTitle;
		return title?.chapters.find((chapter) => chapter.project.projectId === projectId) ?? null;
	}

	function chapterForLanguage(language: string): WorkspaceProjectBrowserChapter | null {
		// The language command panel describes `selectedLanguageChapter` (which honours
		// the currently selected chapter when its language matches). The CTAs must open
		// THAT chapter, not merely the first chapter in the language — otherwise the
		// button opens a different chapter than the one its labels describe.
		if (selectedLanguageChapter?.project.targetLang === language) return selectedLanguageChapter;
		return selectedTitle?.chapters.find((candidate) => candidate.project.targetLang === language) ?? null;
	}

	function latestTitleChapter(title: WorkspaceProjectBrowserGroup): WorkspaceProjectBrowserChapter | null {
		return [...title.chapters]
			.sort((a, b) => b.project.updatedAt.localeCompare(a.project.updatedAt))[0] ?? null;
	}

	function titleProgressLabel(title: WorkspaceProjectBrowserGroup): string {
		const ready = title.readyChapterCount ? $_("library.countChaptersReady", { values: { n: title.readyChapterCount } }) : "";
		const attention = title.attentionChapterCount ? $_("library.countChaptersAttention", { values: { n: title.attentionChapterCount } }) : "";
		const active = title.activeChapterCount ? $_("library.countChaptersActive", { values: { n: title.activeChapterCount } }) : "";
		return [attention, active, ready].filter(Boolean).join(" / ") || $_("library.noBlockers");
	}

	function titleShelfStatusLabel(title: WorkspaceProjectBrowserGroup): string {
		if (title.attentionChapterCount) return $_("library.countChaptersToCheck", { values: { n: title.attentionChapterCount } });
		if (title.activeChapterCount) return $_("library.countChaptersActive", { values: { n: title.activeChapterCount } });
		if (title.readyChapterCount) return $_("library.countChaptersReady", { values: { n: title.readyChapterCount } });
		return $_("library.notStarted");
	}

	function titleShelfChapterLabel(title: WorkspaceProjectBrowserGroup): string {
		const chapter = latestTitleChapter(title);
		if (!chapter) return $_("library.noChaptersYet");
		return chapter.chapterLabel;
	}

	function titleShelfLanguageLabel(title: WorkspaceProjectBrowserGroup): string {
		return title.targetLangs.map((lang) => formatLangCode(lang)).join(", ") || $_("library.noLanguageYet");
	}

	function chapterStateLabel(state: WorkspaceProjectWorkState): string {
		if (state === "attention") return $_("library.stateAttention");
		if (state === "review") return $_("library.stateReview");
		if (state === "active") return $_("library.stateActive");
		if (state === "ready") return $_("library.stateReady");
		return $_("library.stateSetup");
	}

	function selectedChapterLabel(chapter: WorkspaceProjectBrowserChapter | null): string {
		if (!chapter) return $_("library.selectChapter");
		return `${chapter.chapterLabel} · ${formatLangCode(chapter.project.targetLang)}`;
	}

	function chapterNeedsPageSetup(chapter: WorkspaceProjectBrowserChapter | null): boolean {
		return (chapter?.project.pageCount ?? 0) <= 0;
	}

	function hasTitleCover(title: WorkspaceProjectBrowserGroup): boolean {
		return Boolean(titleCoverUrl(title));
	}

	function editorActionLabel(chapter: WorkspaceProjectBrowserChapter | null): string {
		if (!chapter) return $_("library.openPages");
		if (chapterNeedsPageSetup(chapter)) return $_("library.addPageImages");
		if (projectStore.project?.projectId === chapter.project.projectId) {
			return $_("library.openPageNumber", { values: { n: (projectStore.project.currentPage ?? 0) + 1 } });
		}
		return $_("library.openFirstPage");
	}

	function pagesActionLabel(chapter: WorkspaceProjectBrowserChapter | null): string {
		if (!chapter) return $_("library.pagesAndExport");
		return chapter.workState === "ready" ? $_("library.reviewBeforeExport") : $_("library.pagesAndExport");
	}

	function workActionLabel(chapter: WorkspaceProjectBrowserChapter | null): string {
		if (!chapter) return $_("library.viewWorkBoard");
		if (chapter.commentCount) return $_("library.viewComments");
		if (chapter.reviewCount) return $_("library.viewReviewQueue");
		if (chapter.openWorkCount) return $_("library.viewOpenWork");
		return $_("library.viewWorkBoard");
	}

	function focusActionLabel(chapter: WorkspaceProjectBrowserChapter | null): string {
		if (!chapter) return $_("library.reviewOneByOne");
		if (chapter.commentCount || chapter.reviewCount) return $_("library.reviewOneByOne");
		if (chapter.openWorkCount) return $_("library.workOneByOne");
		return $_("library.openWorkOneByOne");
	}

	function chapterActionBlockedLabel(chapter: WorkspaceProjectBrowserChapter | null): string {
		if (!chapter) return $_("library.selectChapterFirst");
		if (isSummaryOnlyChapter(chapter.project.projectId)) return $_("library.openSourceChapterFirst");
		return "";
	}

	function languageActionBlockedLabel(chapter: WorkspaceProjectBrowserChapter | null): string {
		if (!chapter) return $_("library.noChapterInLanguage");
		if (isSummaryOnlyChapter(chapter.project.projectId)) return $_("library.openSourceChapterFirst");
		return "";
	}

	function chapterRowLeadLabel(chapter: WorkspaceProjectBrowserChapter): string {
		if (!selectedTitle) return chapter.chapterLabel;
		const duplicates = selectedTitle.chapters.filter((candidate) =>
			candidate.chapterLabel === chapter.chapterLabel
			&& candidate.project.targetLang === chapter.project.targetLang,
		);
		if (duplicates.length <= 1) return chapter.chapterLabel;
		return `${chapter.chapterLabel} (${chapterStateLabel(chapter.workState)})`;
	}

	function chapterOpenStateLabel(chapter: WorkspaceProjectBrowserChapter): string {
		if (projectStore.project?.projectId !== chapter.project.projectId) return $_("library.openStateNotOpened");
		if (projectStore.saveSyncStatus === "unsaved") return $_("library.openStateOpenUnsaved");
		if (projectStore.saveSyncStatus === "saving") return $_("library.openStateOpenSaving");
		if (projectStore.saveSyncStatus === "error") return $_("library.openStateOpenSaveError");
		return $_("library.openStateOpen");
	}

	function chapterOpenStateChipLabel(chapter: WorkspaceProjectBrowserChapter): string {
		if (projectStore.project?.projectId !== chapter.project.projectId) return $_("library.chipNotOpen");
		if (projectStore.saveSyncStatus === "unsaved") return $_("library.chipUnsaved");
		if (projectStore.saveSyncStatus === "saving") return $_("library.chipSaving");
		if (projectStore.saveSyncStatus === "error") return $_("library.chipSaveError");
		return $_("library.chipOpen");
	}

	// Categorise the chapter's raw (English) nextAction into a short, localized chip label.
	// Matches the stable English action strings — not the already-localized label — so the
	// chip resolves consistently in every UI locale.
	function chapterNextActionChipLabel(action: string): string {
		const lower = action.toLowerCase();
		if (lower.includes("comment")) return $_("library.chipComments");
		if (lower.includes("review")) return $_("library.chipReview");
		if (lower.includes("export")) return $_("library.chipExport");
		if (lower.includes("translate")) return $_("library.chipTranslate");
		if (lower.includes("typeset")) return $_("library.chipTypeset");
		if (lower.includes("clean")) return $_("library.chipClean");
		if (lower.includes("import")) return $_("library.chipImport");
		if (lower.includes("set up") || lower.includes("setup")) return $_("library.chipSetup");
		if (lower.includes("task")) return $_("library.chipTasks");
		// Neutral STAGE fallback (production catch-all): the chip names a work area,
		// never a prescriptive instruction — and never the open-state label, which the
		// rail renders separately ("Open" next to "Not open" would contradict).
		return $_("library.chipProduction");
	}

	function chapterWorkLabel(chapter: WorkspaceProjectBrowserChapter): string {
		const signals = [
			chapter.openWorkCount ? $_("library.countOpenWork", { values: { n: chapter.openWorkCount } }) : "",
			chapter.reviewCount ? $_("library.countReview", { values: { n: chapter.reviewCount } }) : "",
			chapter.commentCount ? $_("library.countComments", { values: { n: chapter.commentCount } }) : "",
		].filter(Boolean);
		return signals.join(" / ") || $_("library.noOpenWork");
	}

	function buildChapterSetupSteps(
		chapter: WorkspaceProjectBrowserChapter,
		focusItems: readonly TaskFocusItem[],
	): ChapterSetupStep[] {
		const pageCount = chapter.project.pageCount ?? 0;
		const textLayerCount = chapter.project.textLayerCount ?? 0;
		const taskCount = chapter.project.taskCount ?? 0;
		const openTaskCount = chapter.project.openTaskCount ?? 0;
		const reviewTaskCount = chapter.project.reviewTaskCount ?? 0;
		const commentCount = chapter.project.openCommentCount ?? 0;
		const attentionCount = focusItems.length || reviewTaskCount + commentCount;
		return [
			{
				id: "images",
				label: $_("library.setupImagesLabel"),
				value: pageCount ? $_("library.countPages", { values: { n: pageCount } }) : $_("library.noPagesYet"),
				detail: pageCount ? $_("library.setupImagesReadyDetail") : $_("library.setupImagesEmptyDetail"),
				tone: pageCount ? "ready" : "hot",
				action: "pages",
				actionLabel: $_("library.setupImagesAction"),
			},
			{
				id: "text",
				label: $_("library.setupTextLabel"),
				value: textLayerCount ? $_("library.countLayers", { values: { n: textLayerCount } }) : $_("library.noTextLayersYet"),
				detail: textLayerCount ? $_("library.setupTextReadyDetail") : $_("library.setupTextEmptyDetail"),
				tone: textLayerCount ? "ready" : "warn",
				action: "import",
				actionLabel: $_("library.setupTextAction"),
			},
			{
				id: "jobs",
				label: isSoloMode ? $_("library.setupJobsLabelSolo") : $_("library.setupJobsLabelTeam"),
				value: taskCount ? $_("library.setupJobsValue", { values: { open: openTaskCount, total: taskCount } }) : $_("library.noJobsYet"),
				detail: isSoloMode
					? (taskCount ? $_("library.setupJobsSoloReadyDetail") : $_("library.setupJobsSoloEmptyDetail"))
					: (taskCount ? $_("library.setupJobsTeamReadyDetail") : $_("library.setupJobsTeamEmptyDetail")),
				tone: openTaskCount ? "warn" : taskCount ? "ready" : "idle",
				action: "work",
				actionLabel: isSoloMode ? $_("library.setupJobsActionSolo") : $_("library.setupJobsActionTeam"),
			},
			{
				id: "review",
				label: $_("library.setupReviewLabel"),
				value: attentionCount ? $_("library.countItems", { values: { n: attentionCount } }) : $_("library.cleared"),
				detail: attentionCount ? $_("library.setupReviewActiveDetail") : $_("library.setupReviewEmptyDetail"),
				tone: commentCount || reviewTaskCount ? "hot" : attentionCount ? "warn" : "ready",
				action: "work",
				actionLabel: $_("library.setupReviewAction"),
			},
		];
	}

	function primaryChapterSetupStepId(
		chapter: WorkspaceProjectBrowserChapter,
		focusItems: readonly TaskFocusItem[],
	): ChapterSetupStep["id"] {
		const pageCount = chapter.project.pageCount ?? 0;
		const textLayerCount = chapter.project.textLayerCount ?? 0;
		const openTaskCount = chapter.project.openTaskCount ?? 0;
		const reviewTaskCount = chapter.project.reviewTaskCount ?? 0;
		const commentCount = chapter.project.openCommentCount ?? 0;
		const hasReviewFocus = focusItems.some((item) =>
			item.kind === "comment"
			|| item.kind === "ai_marker"
			|| item.kind === "qc"
			|| item.kind === "review_task"
			|| item.status === "review",
		);

		if (pageCount <= 0 || chapter.nextAction === "Set up chapters") return "images";
		if (textLayerCount <= 0 || chapter.nextAction === "Import pages or layers") return "text";
		if (
			commentCount
			|| reviewTaskCount
			|| hasReviewFocus
			|| chapter.nextAction.includes("Review")
			|| chapter.nextAction.includes("comments")
		) return "review";
		if (
			openTaskCount
			|| chapter.nextAction.includes("jobs")
			|| chapter.nextAction.includes("workflow")
			|| chapter.nextAction.includes("production")
		) return "jobs";
		return "images";
	}

	function orderChapterSetupSteps(
		steps: ChapterSetupStep[],
		primaryStepId: ChapterSetupStep["id"] | null,
	): ChapterSetupStep[] {
		if (!primaryStepId) return steps;
		return [...steps].sort((a, b) => {
			if (a.id === primaryStepId) return -1;
			if (b.id === primaryStepId) return 1;
			return 0;
		});
	}

	function laneStatusLabel(lane: WorkspaceJobLane): string {
		if (lane.openCount > 0) {
			const urgent = lane.urgentCount ? ` / ${$_("library.countUrgent", { values: { n: lane.urgentCount } })}` : "";
			const overdue = lane.overdueCount ? ` / ${$_("library.countOverdue", { values: { n: lane.overdueCount } })}` : "";
			return `${$_("library.countOpenWork", { values: { n: lane.openCount } })}${urgent}${overdue}`;
		}
		if (lane.totalCount > 0) return $_("library.laneCleared");
		return $_("library.laneNotCreated");
	}

	function reviewCommandTarget(command: ChapterReviewCommand): string {
		if (!command.item) return command.detail;
		const page = command.item.pageIndex === undefined ? $_("library.wholeStory") : $_("library.pageNumber", { values: { n: command.item.pageIndex + 1 } });
		return `${page} / ${focusItemTitleLabel(command.item)}`;
	}

	function reviewCommandEditorActionLabel(command: ChapterReviewCommand): string {
		if (!command.item) return $_("library.openPages");
		if (command.item.pageIndex === undefined) return $_("library.openCurrentPage");
		return $_("library.openPageNumber", { values: { n: command.item.pageIndex + 1 } });
	}

	function focusItemTitleLabel(item: TaskFocusItem): string {
		// Compose the localized title from the focus item's structured fields
		// (the formerly-composed Thai/English title is gone; routing is by code).
		return workInboxTitle(item, $_);
	}

	$effect(() => {
		const chapter = activeStageChapter;
		// Gate on the REACTIVE chapter-detail intent (derived from `page.url`) rather
		// than reading `window.location.pathname` directly: the latter is not a Svelte
		// signal, so this effect would not re-run when navigation lands on a chapter
		// detail route without otherwise changing `activeStageChapter`.
		if (
			!chapter
			|| !chapterDetailIntent
			|| activeChapterLoaded
			|| loadingActiveChapterId === chapter.project.projectId
		) {
			return;
		}

		loadingActiveChapterId = chapter.project.projectId;
		void loadChapterPacket(chapter, currentLibraryTitleKey()).finally(() => {
			if (loadingActiveChapterId === chapter.project.projectId) {
				loadingActiveChapterId = null;
			}
		});
	});
</script>

{#if editorUiStore.workspaceView === "library"}
	<section
		bind:this={libraryShellEl}
		class="ws-surface workspace-library-shell z-[49]"
		class:story-dashboard={selectedTitle && !libraryHomeMode && !chapterDetailIntent}
		class:chapter-dashboard={activeStageChapter && chapterDetailIntent}
		aria-label={$_("library.shellAria")}
	>
	<div class="ws-surface-inner">
		{#snippet librarySearchPanel()}
			{#if normalizedLibrarySearch}
				<div class="ws-panel absolute left-0 right-0 top-[calc(100%+8px)] z-50 max-h-[60vh] overflow-y-auto rounded-ws bg-ws-surface2/95 p-2 backdrop-blur-xl" role="region" aria-label={$_("library.searchResultsAria")}>
					<div class="flex items-center justify-between px-2 py-1.5 text-[11px] font-black text-ws-text/70" role="status">
						<span class="truncate">{$_("library.searchQueryLabel", { values: { query: librarySearchQuery.trim() } })}</span>
						<strong class="flex-none text-ws-accent">{$_("library.searchResultsCount", { values: { n: librarySearchResults.length } })}</strong>
					</div>
					{#if visibleLibrarySearchResults.length > 0}
						<div class="flex flex-col gap-1">
							{#each visibleLibrarySearchResults as result (result.id)}
								<button
									type="button"
									onclick={() => { result.open(); librarySearchQuery = ""; }}
									class="ws-row-hover grid min-h-10 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-ws-card border border-transparent px-3 py-2 text-left"
								>
									<span class={`flex-none rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wide ${result.accent === "violet" ? "bg-ws-violet/15 text-ws-violet" : "bg-ws-cyan/15 text-ws-cyan"}`}>{result.type}</span>
									<span class="min-w-0">
										<strong class="block truncate text-xs font-black text-ws-ink">{result.title}</strong>
										<small class="block truncate text-[10px] text-ws-faint">{result.subtitle}</small>
									</span>
									<em class="flex-none text-[10px] font-bold not-italic text-ws-accent/80">{result.detail}</em>
								</button>
							{/each}
						</div>
					{:else}
						<div class="px-3 py-4 text-center">
							<strong class="block text-xs font-black text-ws-ink">{$_("library.searchNoMatch")}</strong>
							<span class="text-[10px] text-ws-faint">{$_("library.searchHint")}</span>
						</div>
					{/if}
				</div>
			{/if}
		{/snippet}
		<WorkspaceTopUtilityBar bind:value={librarySearchQuery} searchPanel={librarySearchPanel} />
		{#if libraryHomeMode}
			<!-- The library home omits WorkspacePageHeader (which renders the h1), so
			     give the page a real top-level heading for screen readers / document
			     outline. Placed AFTER the utility bar so it doesn't become the surface's
			     :first-child and steal the dock's edge pull-up (ghost top gap, #12). -->
			<h1 class="sr-only">{$_("library.pageTitle")}</h1>
		{/if}
		{#if !libraryHomeMode}
			<div class="library-top w-full">
				<WorkspacePageHeader eyebrow={$_("library.pageTitle")} title={$_("library.headerTitle")} subtitle={libraryHeaderSubtitle}>
					{#snippet actions()}
							<button type="button" onclick={openDashboard} class="ws-btn-ghost inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-xs font-black text-ws-text">{$_("library.home")}</button>
						{#if chapterActionBlockedLabel(activeStageChapter)}
								<span class="library-action-receipt ws-panel-quiet inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-center text-xs font-black leading-tight text-ws-text/70">{chapterActionBlockedLabel(activeStageChapter)}</span>
						{:else if activeStageChapter}
							{#if chapterDetailIntent && activeChapterLoaded}
								<span class="library-action-receipt ready inline-flex min-h-10 items-center justify-center rounded-ws-ctrl border border-ws-green/30 bg-ws-green/10 px-3 text-center text-xs font-black leading-tight text-ws-green">{$_("library.chapterOpenNow")}</span>
							{:else if chapterDetailIntent}
									<span class="library-action-receipt ws-panel-quiet inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-center text-xs font-black leading-tight text-ws-text/70">{$_("library.seeChapterPacketBelow")}</span>
							{:else}
									<span class="library-action-receipt ws-panel-quiet inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-center text-xs font-black leading-tight text-ws-text/70">{$_("library.selectFromChosenStory")}</span>
							{/if}
						{/if}
					{/snippet}
				</WorkspacePageHeader>
			</div>
		{/if}

		{#if showSummaryOnlyNotice}
			<section class="library-summary-route-notice flex w-full flex-col items-stretch justify-between gap-4 rounded-ws border border-ws-violet/25 bg-ws-surface/80 p-4 sm:flex-row sm:items-center" aria-label={$_("library.summaryNoticeAria")}>
				<div class="grid min-w-0 gap-1">
					<span class="text-[10px] font-black uppercase tracking-wider text-ws-violet">{$_("library.localSummary")}</span>
					<h2 class="text-lg font-extrabold leading-tight text-ws-ink">
						{#if selectedTitle && activeStageChapter}
							{$_("library.chapterNotFullyLoaded", { values: { chapter: activeStageChapter.chapterLabel } })}
						{:else}
							{$_("library.linkNotReady")}
						{/if}
					</h2>
						<p class="text-[13px] font-semibold leading-snug text-ws-text/70">{$_("library.openSourceChapterNotice")}</p>
				</div>
				<button type="button" onclick={openLibraryHome} class="ws-btn-ghost inline-flex min-h-10 flex-none items-center justify-center rounded-ws-ctrl px-3.5 text-xs font-black text-ws-ink max-sm:w-full">{$_("library.viewAllLibrary")}</button>
			</section>
		{:else if showMissingTitleNotice}
				<section class="library-summary-route-notice missing flex w-full flex-col items-stretch justify-between gap-4 rounded-ws border border-ws-line/15 bg-ws-surface/80 p-4 sm:flex-row sm:items-center" aria-label={$_("library.missingStoryAria")}>
					<div class="grid min-w-0 gap-1">
						<span class="text-[10px] font-black uppercase tracking-wider text-ws-violet">{$_("library.storyNotFound")}</span>
						<h2 class="text-lg font-extrabold leading-tight text-ws-ink">{$_("library.storyNotFoundTitle")}</h2>
						<p class="text-[13px] font-semibold leading-snug text-ws-text/70">{$_("library.storyNotFoundDetail")}</p>
					</div>
					<button type="button" onclick={openLibraryHome} class="ws-btn-ghost inline-flex min-h-10 flex-none items-center justify-center rounded-ws-ctrl px-3.5 text-xs font-black text-ws-ink max-sm:w-full">{$_("library.viewAllLibrary")}</button>
			</section>
		{/if}

			{#if libraryHomeMode}
				<!-- Pending chapter-team invites also surface here (not just the bell),
				     reusing the shared PendingInvitesPanel fetch + accept flow. -->
				<PendingInvitesPanel variant="banner" />
			{/if}

			{#if projectBrowserGroups.length > 0 && libraryHomeMode}
				<LibraryShelf
					storyCount={projectBrowserGroups.length}
					languageCount={libraryLanguageCount}
					activeChapterCount={libraryActiveChapterCount}
					bind:searchQuery={librarySearchQuery}
					bind:homeFilter={libraryHomeFilter}
					bind:homeTab={libraryHomeTab}
					bind:homeSort={libraryHomeSort}
					bind:viewMode={libraryProjectViewMode}
					tabs={LIBRARY_HOME_TABS}
					tabCount={libraryTabCount}
					filteredCount={filteredLibraryHomeGroups.length}
					inProgress={inProgressLibraryCardViews}
					completed={completedLibraryCardViews}
					onCreate={canManageProjects ? () => startNewChapterFromLibrary("import-review") : undefined}
					onSelectTitle={(titleKey) => selectTitle(titleKey)}
					onResetFilters={() => { librarySearchQuery = ""; libraryHomeTab = "all"; libraryHomeFilter = "all"; }}
				/>
			{:else if showLibraryLoadingSkeleton}
				<!-- Initial load (no titles yet): show a loading skeleton, NOT the
					empty-workspace warning, so the empty state never flashes mid-fetch. -->
				<section class="grid animate-pulse gap-3 py-6" aria-busy="true" aria-label={$_("library.loadingLibrary")}>
					<div class="h-7 w-40 rounded-ws-ctrl bg-ws-surface2/60"></div>
					<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
						{#each Array(5) as _, i (i)}
							<div class="grid gap-2">
							<div class="aspect-[3/4] w-full rounded-ws-card bg-ws-surface2/60"></div>
							<div class="h-3 w-3/4 rounded-full bg-ws-surface2/60"></div>
							<div class="h-2.5 w-1/2 rounded-full bg-ws-surface2/60"></div>
							</div>
						{/each}
					</div>
				</section>
			{:else if libraryHomeMode}
				<LibraryEmptyShelf
					hasError={Boolean(projectStore.recentProjectsError)}
					onCreate={canManageProjects ? () => startNewChapterFromLibrary() : undefined}
					onRefresh={refreshRecentProjects}
				/>
			{/if}

			{#if selectedTitle && !libraryHomeMode}
				<StoryStageHeader
					title={selectedTitle}
					chapterDetailIntent={chapterDetailIntent}
					activeStageChapter={activeStageChapter}
					hasCover={hasTitleCover(selectedTitle)}
					coverParams={titleCoverParams(selectedTitle)}
					coverFallbackLabel={coverFallbackLabel(selectedTitle)}
					selectedLanguage={selectedLanguage}
					selectedChapterLabel={selectedChapterLabel(activeStageChapter)}
					activeChapterNextActionLabel={activeStageChapter ? chapterNextActionChipLabel(activeStageChapter.nextAction) : ""}
					latestChapterLabel={selectedTitleLatestChapter?.chapterLabel ?? ""}
					primaryActionChapter={primaryActionChapter}
					primaryActionLabel={primaryActionLabel}
					primaryActionBlockedLabel={primaryActionChapter ? chapterActionBlockedLabel(primaryActionChapter) : ""}
					editorActionLabelForPrimary={editorActionLabel(primaryActionChapter)}
					teamLabel={libraryTeamLabel()}
					selfDisplayName={selfDisplayName}
					selfInitial={selfInitial}
					selfAvatarInitials={selfAvatarInitials(1)}
					workspaceMemberCount={workspaceMemberCount}
					progressPercent={libraryTitleProgressPercent(selectedTitle)}
					isAssignedMode={isAssignedMode}
					sourceLang={titleSourceLang(selectedTitle)}
					languageProgressCards={storyLanguageProgressCards}
					storyMetricCards={storyMetricCards(selectedTitle)}
					storyMetricCardsCompact={storyMetricCards(selectedTitle, false)}
					languageButtons={storyLanguageButtons}
					languageCommand={storyLanguageCommand}
					chapterRail={storyChapterRail}
					titleProgressLabel={titleProgressLabel(selectedTitle)}
					onOpenPrimaryEditor={() => primaryActionChapter && openChapterEditor(primaryActionChapter.project.projectId, currentLibraryTitleKey())}
					onSelectPrimaryChapter={() => primaryActionChapter && selectChapter(primaryActionChapter.project.projectId, selectedTitle.id)}
					onOpenSettings={canManageProjects ? (() => storySettingsOpen = true) : undefined}
					onSelectLanguage={(lang) => selectLanguage(lang)}
					onOpenLanguageEditor={(lang) => openSelectedLanguageEditor(lang)}
					onOpenLanguagePages={(lang) => openSelectedLanguagePages(lang)}
					onOpenLanguageWork={(lang) => openSelectedLanguageWork(lang)}
					onSelectRailChapter={(projectId) => selectChapter(projectId, selectedTitle.id)}
					onCoverLoad={() => clearTitleCoverFailure(selectedTitle)}
					onCoverError={() => markTitleCoverFailed(selectedTitle)}
				/>

			<section class="story-mode-bar w-full" aria-label={$_("library.storyViewModeAria")}>
				<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
					<ModeToggle subtitle={isAssignedMode ? $_("library.modeAssignedSubtitle", { values: { role: ASSIGNED_ROLE_LABEL } }) : $_("library.modeAllSubtitle")} />
					<div class="flex flex-wrap items-center gap-2">
						{#if isAssignedMode}
							<span class="inline-flex items-center gap-1.5 rounded-full border border-ws-violet/25 bg-ws-violet/10 px-2.5 py-1.5 text-[12px] font-medium text-ws-violet">
								<span class="ws-dot bg-ws-violet"></span> {$_("library.myRole")} · {ASSIGNED_ROLE_LABEL} ({titleSourceLang(selectedTitle)} → {formatLangCode(selectedLanguage ?? selectedTitle.targetLangs[0] ?? "th")})
							</span>
						{:else}
							<div class="hidden flex-wrap items-center gap-1.5 lg:flex">
								<span class="text-[11.5px] text-ws-faint">{$_("library.roleLabel")}</span>
								<RoleBadge role="clean" state="active" />
								<RoleBadge role="translate" state="active" />
								<RoleBadge role="typeset" state="active" />
								<RoleBadge role="qc" state="active" />
							</div>
							<Chip label={`${titleSourceLang(selectedTitle)} → ${formatLangCode(selectedLanguage ?? selectedTitle.targetLangs[0] ?? "th")}`} class="text-ws-cyan" />
						{/if}
					</div>
				</div>
			</section>

			{#if !chapterDetailIntent}
				<section class="story-command-center w-full" aria-label={$_("library.storyCommandAria", { values: { title: selectedTitle.title } })}>
					<div class="story-main-column grid min-w-0 gap-3.5">
						<!-- A story hub leads with its CHAPTERS list (the per-page production pipeline
						     lives on the chapter surface, so the two surfaces stay visually distinct). -->
						{#if !isAssignedMode && chapterFilterLanguages.length > 1}
							<div class="flex flex-wrap items-center gap-1.5" role="group" aria-label={$_("library.chapterFilterAria")}>
								<span class="text-[11px] font-semibold text-ws-faint">{$_("library.chapterFilterLabel")}</span>
								<button
									type="button"
									class={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold transition ${chapterLangFilter === null ? "border-ws-accent bg-ws-accent/12 text-ws-accent" : "border-ws-line/15 text-ws-text hover:text-ws-ink"}`}
									aria-pressed={chapterLangFilter === null}
									onclick={() => { chapterLangFilter = null; storyChapterPage = 1; }}
								>{$_("library.chapterFilterAll")}</button>
								{#each chapterFilterLanguages as lang (lang)}
									<button
										type="button"
										class={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold transition ${chapterLangFilter === lang ? "border-ws-accent bg-ws-accent/12 text-ws-accent" : "border-ws-line/15 text-ws-text hover:text-ws-ink"}`}
										aria-pressed={chapterLangFilter === lang}
										onclick={() => { chapterLangFilter = lang; storyChapterPage = 1; }}
									>{formatLangCode(lang)}</button>
								{/each}
							</div>
						{/if}
						<StoryChapterBoard
							title={selectedTitle}
							isAssignedMode={isAssignedMode}
							assignedRoleLabel={ASSIGNED_ROLE_LABEL}
							assignedRoleChapterCount={assignedRoleChapters.length}
							rows={storyChapterRowViews}
							emptyLabel={isAssignedMode ? $_("library.boardEmptyAssigned", { values: { role: ASSIGNED_ROLE_LABEL } }) : $_("library.boardEmptyAll")}
							showPager={storyChapterPageCount > 1 && !isAssignedMode}
							pageNumbers={storyChapterPageNumbers}
							effectivePage={effectiveStoryChapterPage}
							pageCount={storyChapterPageCount}
							rangeStart={storyChapterPageStart + 1}
							rangeEnd={Math.min(allStoryChapterGroups.length, storyChapterPageStart + STORY_CHAPTER_PAGE_SIZE)}
							totalChapters={allStoryChapterGroups.length}
							onAddChapter={canManageProjects ? () => addChapterToSelectedStory() : undefined}
							onSelectChapter={(projectId) => selectChapter(projectId, selectedTitle.id)}
							onSetPage={(page) => storyChapterPage = page}
						/>

						<section class="story-detail-panel ws-panel-quiet min-w-0 rounded-ws px-4 pb-4" aria-label={$_("library.storyDetailAria", { values: { title: selectedTitle.title } })}>
							<div class="flex min-w-0 gap-1.5 overflow-x-auto border-b border-ws-line/12" role="tablist" aria-label={$_("library.storyDetailTablistAria")}>
								{#each storyDetailTabs as tab (tab.id)}
									<button
										type="button"
										role="tab"
										aria-selected={storyDetailTab === tab.id}
										onclick={() => (storyDetailTab = tab.id)}
										class={`inline-flex min-h-12 items-center whitespace-nowrap border-b-2 px-3 text-xs transition ${storyDetailTab === tab.id ? "active border-ws-accent font-black text-ws-accent" : "border-transparent font-bold text-ws-text/70 hover:text-ws-text"}`}
									>{tab.label}</button>
								{/each}
							</div>
							{#if storyDetailTab === "overview"}
								<div class="story-detail-grid grid grid-cols-1 gap-2.5 pt-3 min-[981px]:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1fr)]">
								<article class="ws-panel-quiet grid content-start gap-2.5 rounded-ws-card bg-ws-surface2/40 p-3.5">
										<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{$_("library.overviewEyebrow")}</span>
										<strong class="text-[15px] font-black text-ws-ink">{selectedTitle.title}</strong>
										<small class="text-[10px] font-semibold leading-snug text-ws-text/60">
											{$_("library.overviewSummary", { values: { chapters: selectedTitle.chapterCount, pages: selectedTitle.totalPages, langs: selectedTitle.targetLangs.map((lang) => formatLangCode(lang)).join(", ") || $_("library.notSet"), deadline: storyDeadlineLabel(selectedTitle) } })}
										</small>
										<small class="text-[10px] font-semibold leading-snug text-ws-text/60">
											{$_("library.overviewMaintainer", { values: { name: `${selfDisplayName}${workspaceName ? ` · ${workspaceName}` : ""}`, date: selectedTitle.latestUpdatedAt.slice(0, 10) } })}
										</small>
									</article>
								<article class="ws-panel-quiet grid content-start gap-2.5 rounded-ws-card bg-ws-surface2/40 p-3.5">
										<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{$_("library.latestSummaryEyebrow")}</span>
									{#if storyRecentChapters.length > 0}
										<ul class="grid gap-1.5">
											{#each storyRecentChapters.slice(0, 4) as chapter (chapter.project.projectId)}
												<li class="flex items-center justify-between gap-2 text-[11px]">
													<span class="min-w-0 truncate font-bold text-ws-ink">{chapter.chapterLabel}</span>
													<span class="flex-none font-semibold tabular-nums text-ws-faint">{chapter.project.updatedAt.slice(0, 10)}</span>
												</li>
											{/each}
										</ul>
									{:else}
										<p class="rounded-ws-ctrl border border-dashed border-ws-line/20 px-3 py-4 text-center text-[11px] font-semibold leading-snug text-ws-faint">
											{$_("library.latestSummaryEmptyLine1")}<br />{$_("library.latestSummaryEmptyLine2")}
										</p>
									{/if}
									</article>
								<article class="ws-panel-quiet grid content-start gap-2.5 rounded-ws-card bg-ws-surface2/40 p-3.5">
										<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{$_("library.latestFilesEyebrow")}</span>
									{#if storyLatestFiles.length > 0}
										<ul class="grid gap-1.5">
											{#each storyLatestFiles as file (file.assetId)}
												<li class="flex items-center justify-between gap-2 text-[11px]">
													<span class="flex min-w-0 items-center gap-1.5">
														<span aria-hidden="true">🖼️</span>
														<span class="min-w-0 truncate font-bold text-ws-ink" title={file.originalName}>{file.originalName}</span>
													</span>
													<span class="flex-none font-semibold tabular-nums text-ws-faint">{file.createdAt.slice(0, 10)}</span>
												</li>
											{/each}
										</ul>
									{:else}
										<p class="rounded-ws-ctrl border border-dashed border-ws-line/20 px-3 py-4 text-center text-[11px] font-semibold leading-snug text-ws-faint">
											{$_("library.latestFilesEmptyLine1")}<br />{$_("library.latestFilesEmptyLine2")}
										</p>
									{/if}
									</article>
								</div>
							{:else if storyDetailTab === "ai"}
								<!-- AI Check (#14d): real per-chapter review + comment counts the board
								     already computes — chapters that have something to verify. -->
								<div class="pt-3" role="tabpanel">
									{#if storyAiCheckChapters.length > 0}
										<div class="mb-2.5 flex flex-wrap gap-2 text-[11px] font-bold">
											<span class="inline-flex items-center gap-1 rounded-full bg-ws-amber/15 px-2 py-0.5 text-ws-amber">{$_("library.aiCheckReview", { values: { n: selectedTitle.reviewTasks } })}</span>
											<span class="inline-flex items-center gap-1 rounded-full bg-ws-cyan/15 px-2 py-0.5 text-ws-cyan">{$_("library.aiCheckComments", { values: { n: selectedTitle.openComments } })}</span>
											{#if selectedTitle.attentionChapterCount > 0}
												<span class="inline-flex items-center gap-1 rounded-full bg-ws-rose/15 px-2 py-0.5 text-ws-rose">{$_("library.aiCheckAttention", { values: { n: selectedTitle.attentionChapterCount } })}</span>
											{/if}
										</div>
										<ul class="grid gap-1.5">
											{#each storyAiCheckChapters as chapter (chapter.project.projectId)}
												<li class="flex items-center justify-between gap-2 rounded-ws-card border border-ws-line/[0.07] bg-ws-surface2/40 px-3 py-2 text-[11px]">
													<span class="min-w-0 truncate font-bold text-ws-ink">{chapter.chapterLabel}</span>
													<span class="flex flex-none items-center gap-2 font-semibold tabular-nums">
														{#if chapter.reviewCount > 0}<span class="text-ws-amber">{$_("library.aiCheckReviewShort", { values: { n: chapter.reviewCount } })}</span>{/if}
														{#if chapter.commentCount > 0}<span class="text-ws-cyan">{$_("library.aiCheckCommentsShort", { values: { n: chapter.commentCount } })}</span>{/if}
													</span>
												</li>
											{/each}
										</ul>
									{:else}
										<p class="whitespace-pre-line rounded-ws-ctrl border border-dashed border-ws-line/20 px-3 py-8 text-center text-[11px] font-semibold leading-snug text-ws-faint">{$_("library.detailTabAiEmpty")}</p>
									{/if}
								</div>
							{:else if storyDetailTab === "history"}
								<!-- History (#14d): a chapter-level activity timeline from real updatedAt
								     timestamps (chapter-grained, not per-edit — honest about its grain). -->
								<div class="pt-3" role="tabpanel">
									{#if storyRecentChapters.length > 0}
										<ul class="grid gap-1.5">
											{#each storyRecentChapters as chapter (chapter.project.projectId)}
												<li class="flex items-center justify-between gap-2 rounded-ws-card border border-ws-line/[0.07] bg-ws-surface2/40 px-3 py-2 text-[11px]">
													<span class="min-w-0 truncate"><strong class="font-bold text-ws-ink">{chapter.chapterLabel}</strong> <span class="text-ws-faint">· {chapter.nextAction}</span></span>
													<span class="flex-none font-semibold tabular-nums text-ws-faint">{chapter.project.updatedAt.slice(0, 10)}</span>
												</li>
											{/each}
										</ul>
									{:else}
										<p class="whitespace-pre-line rounded-ws-ctrl border border-dashed border-ws-line/20 px-3 py-8 text-center text-[11px] font-semibold leading-snug text-ws-faint">{$_("library.detailTabHistoryEmpty")}</p>
									{/if}
								</div>
							{:else}
								<!-- Notes/Files: genuinely need a backing data source (per-story asset
								     listing) — honest empty state, never fabricated content. -->
								<div class="pt-3" role="tabpanel">
								<p class="whitespace-pre-line rounded-ws-ctrl border border-dashed border-ws-line/20 px-3 py-8 text-center text-[11px] font-semibold leading-snug text-ws-faint">
										{activeStoryDetailTab.emptyText}
									</p>
								</div>
							{/if}
						</section>

					</div>

					<StorySideRail
						title={selectedTitle}
						isAssignedMode={isAssignedMode}
						workspaceMemberCount={workspaceMemberCount}
						selfDisplayName={selfDisplayName}
						selfInitial={selfInitial}
					/>
				</section>
			{/if}

			{#if activeStageChapter && chapterDetailIntent}
				<ChapterPacketPanel
					chapter={activeStageChapter}
					title={selectedTitle}
					coverParams={selectedTitle ? titleCoverParams(selectedTitle) : null}
					coverFallbackLabel={selectedTitle ? coverFallbackLabel(selectedTitle) : "CH"}
					teamLabel={libraryTeamLabel()}
					selfDisplayName={selfDisplayName}
					selfInitial={selfInitial}
					teamInitials={chapterTeamInitials(activeStageChapter)}
					workspaceMemberCount={workspaceMemberCount}
					progressPercent={chapterProgressPercent(activeStageChapter)}
					blockedLabel={chapterActionBlockedLabel(activeStageChapter)}
					heroMetricCards={chapterHeroMetricCards(activeStageChapter)}
					pipelineAriaLabel={$_("library.pipelineChapterAria", { values: { chapter: activeStageChapter.chapterLabel } })}
					pipelineCards={chapterPipelineCards(activeStageChapter)}
					productionMetricCards={chapterProductionMetricCards(activeStageChapter)}
					isSoloMode={isSoloMode}
					activeChapterLoaded={activeChapterLoaded}
					loadingThisChapter={loadingActiveChapterId === activeStageChapter.project.projectId}
					project={projectStore.project}
					pageSummaries={activeChapterPageSummaries}
					selectedPageIndex={projectStore.project?.currentPage ?? null}
					jobLanes={activeChapterJobLanes}
					openLaneCount={activeChapterOpenLaneCount}
					doneCount={activeChapterDoneCount}
					taskCount={activeChapterTaskCount}
					laneStatusLabel={laneStatusLabel}
					reviewCommands={packetReviewCommandViews}
					activityCommands={packetActivityCommandViews}
					todayOpenTaskCount={activeStageChapter.project.openTaskCount ?? activeStageChapter.openWorkCount}
					todayReviewCount={activeStageChapter.reviewCount}
					todayCommentCount={activeStageChapter.commentCount}
					onOpenEditor={() => openChapterEditor(activeStageChapter.project.projectId, currentLibraryTitleKey())}
					onOpenWork={() => openChapterWork(activeStageChapter.project.projectId, currentLibraryTitleKey())}
					onOpenSettings={canManageProjects ? (() => storySettingsOpen = true) : undefined}
					onOpenFocus={() => openChapterFocus(activeStageChapter.project.projectId, currentLibraryTitleKey())}
					onOpenPipelineAction={() => openChapterFocus(activeStageChapter.project.projectId, currentLibraryTitleKey())}
					onOpenPage={openLoadedChapterPage}
					onLoadPacketMap={() => loadChapterPacket(activeStageChapter, currentLibraryTitleKey())}
					onLoadPacketWork={() => selectedTitle && loadChapterPacket(activeStageChapter, selectedTitle.id)}
					onOpenLaneFocus={(lane) => selectedTitle && openChapterLaneFocus(activeStageChapter, lane, selectedTitle.id)}
					onCopyLaneLink={(lane) => void copyChapterLaneFocusLink(activeStageChapter, lane)}
					onFocusReviewCommand={(id) => { const command = chapterReviewCommandById(id); if (command) void focusChapterReviewCommand(command); }}
					onOpenReviewCommandInEditor={(id) => { const command = chapterReviewCommandById(id); if (command) void openChapterReviewCommandInEditor(command); }}
					onCoverLoad={() => selectedTitle && clearTitleCoverFailure(selectedTitle)}
					onCoverError={() => selectedTitle && markTitleCoverFailed(selectedTitle)}
				/>
			{/if}

			{#if activeStageChapter && selectedLanguageSummary && selectedTitle.languageSummaries.length > 1}
				<section
					class="language-queue grid w-full gap-2.5 rounded-ws border border-ws-line/12 bg-ws-surface/80 p-3"
					aria-label={$_("library.languageQueueAria", { values: { lang: formatLangCode(selectedLanguageSummary.lang), title: selectedTitle.title } })}
				>
					<header class="language-queue-head flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-end">
						<div class="min-w-0">
							<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{$_("library.languageQueueEyebrow")}</span>
							<h2 class="text-[25px] font-black leading-tight text-ws-ink [overflow-wrap:anywhere]">{$_("library.languageQueueTitle", { values: { lang: formatLangCode(selectedLanguageSummary.lang) } })}</h2>
							<p class="mt-1 text-xs font-semibold leading-snug text-ws-text/70">
								{$_("library.countChapters", { values: { n: selectedLanguageChapters.length } })} / {$_("library.countPages", { values: { n: selectedLanguageSummary.pageCount } })} /
								{languageQueueLeadChapter ? chapterWorkLabel(languageQueueLeadChapter) : $_("library.noOpenWork")}
							</p>
						</div>
						<div class="language-queue-actions flex flex-none items-center gap-1.5 max-sm:[&>button]:flex-1">
							{#if languageActionBlockedLabel(selectedLanguageChapter)}
							<span class="library-action-receipt ws-panel-quiet inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-center text-xs font-black leading-tight text-ws-text/70">{languageActionBlockedLabel(selectedLanguageChapter)}</span>
							{:else}
								<button
									type="button"
								class="ws-btn-ghost inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-xs font-black text-ws-text"
									onclick={() => openSelectedLanguageFocus(selectedLanguageSummary.lang)}
								>
									{focusActionLabel(selectedLanguageChapter)}
								</button>
								<button
									type="button"
								class="ws-btn-ghost inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-xs font-black text-ws-text"
									onclick={() => openSelectedLanguagePages(selectedLanguageSummary.lang)}
								>
									{pagesActionLabel(selectedLanguageChapter)}
								</button>
								<button
									type="button"
								class="primary ws-grad-primary inline-flex min-h-10 items-center justify-center rounded-ws-ctrl border border-ws-accent/35 px-3 text-xs font-black text-white transition hover:brightness-110"
									onclick={() => openSelectedLanguageEditor(selectedLanguageSummary.lang)}
								>
										{editorActionLabel(selectedLanguageChapter)}
								</button>
							{/if}
						</div>
					</header>
					<div class="language-queue-grid grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-2">
						{#each selectedLanguageChapters as chapter (chapter.project.projectId)}
							<article
								class={`language-queue-card grid min-w-0 gap-2.5 rounded-ws border p-2.5 ${chapter.project.projectId === activeStageChapter?.project.projectId ? "active border-ws-accent/35 bg-ws-accent/[0.08]" : "border-ws-line/12 bg-ws-surface2/35"}`}
								class:active={chapter.project.projectId === activeStageChapter?.project.projectId}
							>
								<div class="language-card-copy grid gap-1">
									<span class="text-[10px] font-black uppercase tracking-wider text-ws-accent">{formatLangCode(chapter.project.targetLang)} / {chapterStateLabel(chapter.workState)}</span>
									<h3 class="text-lg font-black leading-tight text-ws-ink [overflow-wrap:anywhere]">{chapter.chapterLabel}</h3>
										<p class="text-xs font-semibold leading-snug text-ws-text/70">{selectedTitle.title} {chapter.chapterLabel}</p>
								</div>
								<div class="language-card-metrics grid grid-cols-2 gap-1.5 min-[761px]:grid-cols-4" aria-label={$_("library.workSignalsAria", { values: { chapter: chapter.chapterLabel, lang: formatLangCode(chapter.project.targetLang) } })}>
								<span class="grid min-w-0 gap-0.5 rounded-ws-ctrl border border-ws-line/12 bg-ws-surface2/50 px-2 py-1.5 text-[10px] font-semibold text-ws-faint"><strong class="text-[17px] font-black leading-none text-ws-ink">{chapter.project.pageCount}</strong> {$_("library.unitPages")}</span>
								<span class="grid min-w-0 gap-0.5 rounded-ws-ctrl border border-ws-line/12 bg-ws-surface2/50 px-2 py-1.5 text-[10px] font-semibold text-ws-faint"><strong class="text-[17px] font-black leading-none text-ws-ink">{chapter.openWorkCount}</strong> {$_("library.unitOpen")}</span>
								<span class="grid min-w-0 gap-0.5 rounded-ws-ctrl border border-ws-line/12 bg-ws-surface2/50 px-2 py-1.5 text-[10px] font-semibold text-ws-faint"><strong class="text-[17px] font-black leading-none text-ws-ink">{chapter.reviewCount}</strong> {$_("library.unitReview")}</span>
								<span class="grid min-w-0 gap-0.5 rounded-ws-ctrl border border-ws-line/12 bg-ws-surface2/50 px-2 py-1.5 text-[10px] font-semibold text-ws-faint"><strong class="text-[17px] font-black leading-none text-ws-ink">{chapter.commentCount}</strong> {$_("library.unitComments")}</span>
								</div>
								<p class="language-card-next text-xs font-semibold leading-snug text-ws-text/70">{chapterWorkLabel(chapter)}</p>
								<div class="language-card-actions flex flex-wrap items-center gap-1.5 max-[760px]:[&>button]:flex-[1_1_calc(50%-4px)]">
									<button
										type="button"
									class="ws-btn-ghost inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-[11px] font-black text-ws-text"
										aria-label={$_("library.openReviewAria", { values: { chapter: chapter.chapterLabel, lang: formatLangCode(chapter.project.targetLang) } })}
										onclick={() => openChapterFocus(chapter.project.projectId, currentLibraryTitleKey())}
									>
										{focusActionLabel(chapter)}
									</button>
									<button
										type="button"
									class="ws-btn-ghost inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-[11px] font-black text-ws-text"
											aria-label={$_("library.managePagesAria", { values: { chapter: chapter.chapterLabel, lang: formatLangCode(chapter.project.targetLang) } })}
										onclick={() => openChapterPages(chapter.project.projectId, currentLibraryTitleKey())}
									>
										{pagesActionLabel(chapter)}
									</button>
									<button
										type="button"
									class="ws-btn-ghost inline-flex min-h-10 items-center justify-center rounded-ws-ctrl px-3 text-[11px] font-black text-ws-text"
											aria-label={$_("library.openTodoWorkAria", { values: { chapter: chapter.chapterLabel, lang: formatLangCode(chapter.project.targetLang) } })}
										onclick={() => openChapterWork(chapter.project.projectId, currentLibraryTitleKey())}
									>
									{workActionLabel(chapter)}
									</button>
									<button
										type="button"
									class="primary ws-grad-primary inline-flex min-h-10 items-center justify-center rounded-ws-ctrl border border-ws-accent/35 px-3 text-[11px] font-black text-white transition hover:brightness-110"
											aria-label={$_("library.openPageEditorAria", { values: { chapter: chapter.chapterLabel, lang: formatLangCode(chapter.project.targetLang) } })}
										onclick={() => openChapterEditor(chapter.project.projectId, currentLibraryTitleKey())}
									>
											{editorActionLabel(chapter)}
									</button>
								</div>
							</article>
						{/each}
					</div>
				</section>
				{/if}
		{/if}

			{#if storySettingsOpen && selectedTitle}
				<StorySettingsDialog
					open={storySettingsOpen}
					title={selectedTitle}
					selfDisplayName={selfDisplayName}
					workspaceName={workspaceName}
					workspaceId={resolvedWorkspaceId}
					deadlineLabel={storyDeadlineLabel(selectedTitle)}
					canManage={canManageProjects}
					onRename={(nextTitle) => handleStoryRename(selectedTitle!, nextTitle)}
					onDelete={() => handleStoryDelete(selectedTitle!)}
					onClose={() => storySettingsOpen = false}
				/>
			{/if}
	</div>
	</section>
{/if}

<style>
	/* Most visual styling is expressed with Tailwind utilities in the markup above.
	   The rules kept here are the parent-class-driven dashboard layouts
	   (.story-dashboard / .chapter-dashboard) that orchestrate grid placement, order,
	   sticky positioning and the responsive hero reflow across many descendant elements
	   at once — something Tailwind cannot express on this component. */

	/* ── Story route: full-bleed shell (matches chapter/dashboard) with a centered
	   hero on top and a (main column | sticky side rail) grid below. The shell keeps
	   its Tailwind flex-column-center layout so the page background stays full-width;
	   only the content is capped at 1480px via the children's max-w utilities.

	   These rules orchestrate descendants that now live inside the extracted library
	   composites (StoryStageHeader / StorySideRail / ChapterPacketPanel). The shell
	   root (.workspace-library-shell.story-dashboard / .chapter-dashboard) is still
	   rendered here, so it stays component-scoped; the descendant hooks are wrapped in
	   :global(...) so the layout still reaches across the component boundary without
	   any visual change. ── */
	.workspace-library-shell.story-dashboard :global(.library-title-stage) {
		width: 100%;
		display: grid;
		grid-template-columns: 150px minmax(0, 1fr);
		gap: 22px;
		padding: 20px 20px 16px;
	}

	.workspace-library-shell.story-dashboard :global(.stage-cover) {
		width: 150px;
		max-width: 150px;
	}

	.workspace-library-shell.story-dashboard :global(.stage-copy) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-content: start;
		gap: 12px 18px;
	}

	.workspace-library-shell.story-dashboard :global(.stage-path) {
		grid-column: 1 / -1;
		max-width: 100%;
	}

	.workspace-library-shell.story-dashboard :global(.stage-title-row) {
		display: contents;
	}

	.workspace-library-shell.story-dashboard :global(.stage-title-row > div:first-child) {
		grid-column: 1;
		min-width: 0;
		align-self: start;
	}

	.workspace-library-shell.story-dashboard :global(.title-stage-actions) {
		grid-column: 2;
		grid-row: 1;
		align-self: start;
		justify-self: end;
		display: flex;
		flex-direction: column;
		width: auto;
		max-width: 280px;
		gap: 8px;
	}

	.workspace-library-shell.story-dashboard :global(.title-stage-actions button) {
		width: 100%;
	}

	.workspace-library-shell.story-dashboard :global(.story-hero-team) {
		grid-column: 1;
		width: min(100%, 540px);
		/* bar may shrink so the row never clips the % on a narrow info column */
		grid-template-columns: auto auto minmax(40px, 1fr) auto;
	}

	.workspace-library-shell.story-dashboard :global(.story-kpis),
	.workspace-library-shell.story-dashboard :global(.stage-lang-progress),
	.workspace-library-shell.story-dashboard :global(.story-hero-roles) {
		grid-column: 1 / -1;
	}

	.workspace-library-shell.story-dashboard :global(.stage-languages),
	.workspace-library-shell.story-dashboard :global(.stage-progress) {
		display: none;
	}

	.workspace-library-shell.story-dashboard .story-command-center {
		display: grid;
		align-items: start;
		grid-template-columns: minmax(0, 1fr) minmax(280px, 300px);
		gap: 16px 18px;
	}

	.workspace-library-shell.story-dashboard .story-main-column {
		min-width: 0;
		width: 100%;
	}

	.workspace-library-shell.story-dashboard :global(.story-side-rail) {
		width: 100%;
		align-self: start;
		position: sticky;
		top: 16px;
	}

	@media (max-width: 1180px) {
		.workspace-library-shell.story-dashboard .story-command-center {
			grid-template-columns: minmax(0, 1fr);
		}

		.workspace-library-shell.story-dashboard :global(.story-side-rail) {
			position: static;
		}
	}

	@media (max-width: 1080px) {
		.workspace-library-shell.story-dashboard :global(.library-title-stage) {
			grid-template-columns: 112px minmax(0, 1fr);
			padding: 16px;
		}

		.workspace-library-shell.story-dashboard :global(.stage-cover) {
			width: 112px;
			max-width: 112px;
		}

		.workspace-library-shell.story-dashboard :global(.stage-copy) {
			grid-template-columns: minmax(0, 1fr);
		}

		.workspace-library-shell.story-dashboard :global(.stage-title-row > div:first-child),
		.workspace-library-shell.story-dashboard :global(.story-hero-team),
		.workspace-library-shell.story-dashboard :global(.title-stage-actions) {
			grid-column: 1;
		}

		.workspace-library-shell.story-dashboard :global(.title-stage-actions) {
			grid-row: auto;
			width: 100%;
			max-width: none;
		}
	}

	/* Phone: stack the header to a single column so the short cover no longer leaves
	   a tall empty gutter beside the info column, and the info gets full width. */
	@media (max-width: 640px) {
		.workspace-library-shell.story-dashboard :global(.library-title-stage) {
			grid-template-columns: 1fr;
			gap: 14px;
		}

		.workspace-library-shell.story-dashboard :global(.stage-cover) {
			width: 96px;
			max-width: 96px;
		}
	}

	/* ── Chapter route: centered packet with operating layout + sticky collab rail ── */
	.workspace-library-shell.chapter-dashboard {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 14px;
	}

	.workspace-library-shell.chapter-dashboard :global(.library-top),
	.workspace-library-shell.chapter-dashboard :global(.library-title-stage),
	.workspace-library-shell.story-dashboard :global(.library-top) {
		display: none;
	}

	.workspace-library-shell :global(.chapter-operating-layout) {
		grid-template-columns: minmax(0, 1fr) 292px;
	}

	.workspace-library-shell :global(.chapter-packet-head) {
		grid-template-columns: 150px minmax(0, 1fr) minmax(230px, auto);
		min-height: 170px;
	}

	.workspace-library-shell :global(.chapter-hero-metrics-slot) {
		grid-column: 1 / -1;
	}

	.workspace-library-shell :global(.chapter-collaboration-rail) {
		position: sticky;
		top: 12px;
	}

	@media (max-width: 1080px) {
		.workspace-library-shell :global(.chapter-operating-layout) {
			grid-template-columns: 1fr;
		}

		.workspace-library-shell :global(.chapter-collaboration-rail) {
			position: static;
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}

		.workspace-library-shell.chapter-dashboard :global(.chapter-packet-head) {
			grid-template-columns: 104px minmax(0, 1fr);
			min-height: 0;
		}

		/* keep the cover inside its track so it never overlaps the title/meta */
		.workspace-library-shell.chapter-dashboard :global(.chapter-hero-cover),
		.workspace-library-shell.chapter-dashboard :global(.chapter-cover-fallback) {
			width: 104px;
			height: 146px;
		}

		.workspace-library-shell.chapter-dashboard :global(.chapter-hero-actions) {
			grid-column: 1 / -1;
		}
	}

	@media (max-width: 760px) {
		.workspace-library-shell.chapter-dashboard :global(.chapter-packet-head) {
			grid-template-columns: 92px minmax(0, 1fr);
		}

		.workspace-library-shell.chapter-dashboard :global(.chapter-hero-cover),
		.workspace-library-shell.chapter-dashboard :global(.chapter-cover-fallback) {
			width: 92px;
			height: 126px;
		}

		.workspace-library-shell :global(.chapter-collaboration-rail) {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.workspace-library-shell.chapter-dashboard :global(.chapter-hero-actions) {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 44px;
		}
	}

</style>
