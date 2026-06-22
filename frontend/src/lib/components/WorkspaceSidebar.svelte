<!-- WorkspaceSidebar - persistent left navigation sidebar for Workspace Shell -->
<script lang="ts">
	import { page } from "$app/state";
	import { goto, invalidateAll } from "$app/navigation";
	import { onMount, onDestroy } from "svelte";
	import { _, chapterLabelPrefix } from "$lib/i18n";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { commandPaletteStore } from "$lib/stores/command-palette.svelte.ts";
	import { searchStore } from "$lib/stores/search.svelte.ts";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { authUiStore, type AuthModalMode } from "$lib/stores/auth-ui.svelte.ts";
	import { workspaceRoleLabelFor, workspacesStore } from "$lib/stores/workspaces.svelte.ts";
	import { leaveWorkspace, listStoryAssignments, type StoryRoleAssignment, type WorkspaceRecord } from "$lib/api/client";
	import { queueWorkspaceNavigation } from "$lib/navigation/workspace-navigation.js";
	import { buildWorkspaceProjectBrowser } from "$lib/project/workspace-dashboard.js";
	import { findStoryGroupByTitleKey, storyIdFromTitleKey } from "$lib/project/story-id.js";
	import { resolveStoryTitle, resolveChapterLabel, titleFallback } from "$lib/navigation/workspace-labels.js";
	import AvatarStack from "$lib/components/ui/AvatarStack.svelte";
	import { dialogFocus } from "$lib/components/Dialog.svelte";
	import { billingStore } from "$lib/stores/billing.svelte.ts";
	import { usageStore, formatBytes } from "$lib/stores/usage.svelte.ts";
	import { perfAnalyticsStore } from "$lib/stores/perf-analytics.svelte.ts";
	import PlanBadge from "$lib/components/ui/PlanBadge.svelte";
	import { workspaceIdentityFor } from "$lib/workspace/identity";

	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}
	let isMac = $derived(
		typeof navigator !== "undefined" && /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent),
	);
	let commandPaletteShortcut = $derived(isMac ? "⌘K" : "Ctrl K");

	let hasProject = $derived(Boolean(projectStore.project));
	let currentPathname = $derived(page.url.pathname);
	// On the standalone, non-(workspace) surfaces (/storage, /settings/*,
	// /support/*, /notifications) the in-shell `editorUiStore.workspaceView` is
	// stale (it defaults to "dashboard" and isn't driven by these routes), so the
	// view-derived nav highlights would wrongly light up Dashboard. /storage and
	// /settings own their own highlight via `onStorageRoute`/`onSettingsRoute`
	// below; /support and /notifications have no sidebar entry, so they get no
	// highlight at all — but they still must neutralise the stale Dashboard
	// highlight here while we're on them.
	let onStandaloneRoute = $derived(
		currentPathname === "/storage"
		|| currentPathname.startsWith("/storage/")
		|| currentPathname === "/settings"
		|| currentPathname.startsWith("/settings/")
		|| currentPathname === "/support"
		|| currentPathname.startsWith("/support/")
		|| currentPathname === "/notifications"
		|| currentPathname.startsWith("/notifications/"),
	);
	let activeView = $derived(onStandaloneRoute ? null : editorUiStore.workspaceView);
	let libraryViewActive = $derived(activeView === "library");
	let totalPages = $derived(projectStore.project?.pages.length ?? 0);
	let currentPageIndex = $derived(projectStore.project?.currentPage ?? 0);
	let projectBrowserGroups = $derived(buildWorkspaceProjectBrowser(projectStore.recentProjects, 24, 100, $chapterLabelPrefix));
	let currentStoryKey = $derived(projectStore.project?.storyId ?? editorUiStore.workspaceTitleKey ?? null);
	// Navigation key for the open story: prefer the group's hybrid `<id>-<slug>`
	// segment (readable URL) and fall back to the raw key (id alone still resolves).
	let currentStoryNavKey = $derived(
		currentStoryKey
			? (findStoryGroupByTitleKey(projectBrowserGroups, (group) => group.storyId, currentStoryKey)?.id ?? currentStoryKey)
			: null,
	);
	// Story and chapter are independent slots: the story keeps its own identity even
	// when a chapter of it is open (no more both slots collapsing to project.name).
	let currentStoryLabel = $derived(
		resolveStoryTitle(projectBrowserGroups, currentStoryKey)
		|| projectStore.project?.storyTitle?.trim()
		|| titleFallback(currentStoryKey, msg("sidebar.library", "คลังการ์ตูน")),
	);
	let currentChapterLabel = $derived(
		resolveChapterLabel(projectBrowserGroups, projectStore.project?.projectId, currentStoryKey)
		|| projectStore.project?.chapterLabel?.trim()
		|| msg("sidebar.openChapter", "Open chapter"),
	);
	// Pinned chapter persists while its project is loaded (independent of the current
	// route) so it stays available in the sidebar until a different chapter is opened.
	let currentChapterSelected = $derived(Boolean(projectStore.project));
	let onOverviewRoute = $derived(currentPathname === "/" || currentPathname === "/library");
	let onStoryRoute = $derived(/^\/library\/[^/]+$/.test(currentPathname));
	let onChapterRoute = $derived(
		/^\/library\/[^/]+\/chapters\//.test(currentPathname) || /^\/projects\/[^/]+/.test(currentPathname),
	);
	let librarySubnavOpen = $state(true);
	let workflowSubnavOpen = $state(true);
	let switcherOpen = $state(false);
	let createWorkspaceName = $state("");
	let workspaceActionBusy = $state(false);
	let leaveWorkspaceTarget = $state<WorkspaceRecord | null>(null);
	let leaveWorkspaceBusy = $state(false);
	let leaveWorkspaceError = $state<string | null>(null);
	// Inline error surface for a FAILED create-workspace (offline, email-verification-
	// required, server rejection). Without this the failure was silent — the popover
	// just showed the input/button with no feedback. We keep the popover open + the
	// typed name so the user can read the error and retry.
	let createWorkspaceError = $state<string | null>(null);
	let workflowViewActive = $derived(["editor", "import", "pages", "work", "review"].includes(activeView ?? ""));
	let currentWorkspace = $derived(workspacesStore.currentWorkspace);
	let currentWorkspaceName = $derived(currentWorkspace?.name ?? "Comic Workspace");
	let currentWorkspaceIdentity = $derived(workspaceIdentityFor({
		workspaceId: currentWorkspace?.workspaceId,
		name: currentWorkspaceName,
	}));

	// แบ่งบ้านเป็น 2 กลุ่มให้อ่านง่าย: บ้านของฉัน (owner) กับบ้านที่เข้าร่วม
	let switcherSections = $derived([
		{
			id: "mine",
			label: msg("sidebar.sectionMyWorkspaces", "บ้านของฉัน"),
			workspaces: workspacesStore.workspaces.filter((workspace) => workspace.memberRole === "owner"),
		},
		{
			id: "joined",
			label: msg("sidebar.sectionJoinedWorkspaces", "บ้านที่เข้าร่วม"),
			workspaces: workspacesStore.workspaces.filter((workspace) => workspace.memberRole !== "owner"),
		},
	]);
	// Plan label under the workspace name — resolved from the SAME effective plan
	// that drives the usage meters (usageStore), so it can't disagree with the
	// AI-credit cap. Falls back to the workspace's billing planId until usage loads.
	let currentWorkspacePlan = $derived(
		usageStore.resolvedPlanName
			? `${usageStore.resolvedPlanName} plan`
			: currentWorkspace?.planId
				? `${currentWorkspace.planId} plan`
				: "Workspace plan",
	);
	// ── Scoped "Your team": ONLY people on the in-context story/chapter ──────
	// (was the full workspace roster with raw userIds — wrong people, wrong names).
	// Effective roster = series duty assignments for the in-context story, with
	// ACTIVE chapter-team rows overriding per-user when a chapter is open (same
	// override semantics the backend's duty resolution uses). With no story or
	// chapter in context — or an empty roster — it falls back to just yourself.
	interface ScopedTeamEntry { userId?: string; name: string }
	// The open project counts toward THIS workspace's roster only when it belongs
	// here: switching workspaces keeps the previous chapter loaded, and its team
	// must not bleed into the new workspace's sidebar. A legacy project with no
	// workspace stamp is trusted (it has no foreign roster to leak).
	let scopedProject = $derived(
		projectStore.project && (!projectStore.project.workspaceId || projectStore.project.workspaceId === workspacesStore.currentWorkspaceId)
			? projectStore.project
			: null,
	);
	// Story context for the roster, from WORKSPACE-GATED sources only (a stale
	// foreign chapter must not contribute its storyId either).
	let scopedStoryKey = $derived(scopedProject?.storyId ?? editorUiStore.workspaceTitleKey ?? null);
	// The duty API is keyed by the RAW storyId, while the story-route key is the
	// hybrid `<storyId>-<slug>` URL segment — resolve through the browser groups
	// (exact match also covers legacy slug-only ids), with the token-prefix
	// extraction as the groups-not-loaded fallback.
	let assignmentStoryId = $derived(
		scopedProject?.storyId
		?? findStoryGroupByTitleKey(projectBrowserGroups, (group) => group.storyId, scopedStoryKey)?.storyId
		?? (scopedStoryKey ? storyIdFromTitleKey(scopedStoryKey) : null),
	);
	let storyAssignments = $state<StoryRoleAssignment[]>([]);
	let storyAssignmentsKey = $state<string | null>(null);
	$effect(() => {
		const workspaceId = workspacesStore.currentWorkspaceId;
		const storyId = assignmentStoryId;
		// Auth folds into the key so signing in AFTER mount triggers the fetch
		// (a skip-when-logged-out guard alone would never re-run for it).
		const key = workspaceId && storyId && isAuthenticated ? `${workspaceId}|${storyId}` : null;
		if (key === storyAssignmentsKey) return;
		storyAssignmentsKey = key;
		storyAssignments = [];
		if (!key || !workspaceId || !storyId) return;
		void listStoryAssignments(workspaceId, storyId)
			.then((result) => {
				// A slow response for a PREVIOUS story must not clobber the current one.
				if (storyAssignmentsKey === key) storyAssignments = result.assignments;
			})
			.catch(() => {/* roster stays scoped-empty; self fallback below */});
	});
	let scopedTeam = $derived.by((): ScopedTeamEntry[] => {
		const byUser = new Map<string, ScopedTeamEntry>();
		for (const entry of storyAssignments) {
			byUser.set(entry.userId, { userId: entry.userId, name: entry.displayName?.trim() || entry.email?.trim() || entry.userId });
		}
		// Chapter open IN THIS WORKSPACE → its ACTIVE chapter-team rows
		// override/extend the series roster.
		for (const member of scopedProject?.chapterTeam ?? []) {
			if (member.status !== "active") continue;
			const id = member.userId ?? member.id;
			byUser.set(id, { userId: member.userId, name: member.displayName?.trim() || member.email?.trim() || id });
		}
		if (byUser.size === 0) {
			const selfName = authStore.user?.name || authStore.user?.email;
			return selfName ? [{ userId: authStore.user?.id, name: selfName }] : [];
		}
		return Array.from(byUser.values());
	});
	let memberAvatarItems = $derived(scopedTeam.slice(0, 5).map((member, index) => ({
		name: member.name,
		initial: member.name.charAt(0),
		tone: (["violet", "cyan", "green", "amber", "rose"] as const)[index % 5],
	})));
	let teamLabel = $derived(scopedTeam.length ? `${msg("sidebar.yourTeam", "Your team")} · ${scopedTeam.length}` : msg("sidebar.yourTeam", "Your team"));
	let authName = $derived(authStore.user?.name || authStore.user?.email || msg("sidebar.account", "Account"));
	let authInitial = $derived((authName.charAt(0) || "?").toUpperCase());
	let authEmail = $derived(authStore.user?.email ?? "");
	let authRoleLabel = $derived(
		authStore.role ? authStore.role[0].toUpperCase() + authStore.role.slice(1) : msg("sidebar.user", "User"),
	);
	// The sidebar is the one workspace chrome that stays visible on the dashboard,
	// library, and pages surfaces (the toolbar — and its AuthAccountMenu — is
	// hidden there by `.toolbar-area { display:none }`). So the only reliable
	// place to expose "who am I" + sign out on those surfaces is this sidebar
	// account menu. Without it a logged-in user has no logout affordance at all.
	let accountMenuOpen = $state(false);
	let signOutBusy = $state(false);
	let isAuthenticated = $derived(authStore.isAuthenticated);

	// Surface the in-context AuthModal. On success we re-run route guards so a now
	// signed-in user immediately gets their guarded workspace data (the workspace
	// `+layout.ts` guard otherwise only runs on navigation).
	function openAuthModal(mode: AuthModalMode): void {
		authUiStore.openAuthModal(mode, () => {
			void invalidateAll();
		});
	}

	async function handleSidebarSignOut(): Promise<void> {
		if (signOutBusy) return;
		signOutBusy = true;
		try {
			await authStore.signOut();
			accountMenuOpen = false;
			// Re-run route guards so the now-anonymous user is bounced to /login
			// immediately (the workspace `+layout.ts` guard only runs on navigation).
			await invalidateAll();
		} finally {
			signOutBusy = false;
		}
	}

	onMount(() => {
		void authStore.init().catch(() => undefined);
	});

	// Reload workspaces whenever the signed-in identity changes. A one-shot onMount
	// load() would leave the store stuck in `error` if the shell first mounted while
	// anonymous and the user signed in later (no token on the first /workspaces call).
	// Tracking authStore.user?.id reactively re-fetches on in-session sign-in/sign-out.
	$effect(() => {
		const userId = authStore.user?.id ?? null;
		void workspacesStore.syncWithAuth(userId).catch(() => undefined);
	});

	// --- usage + billing widgets (W2.2) ----------------------------------------
	// Read the live workspace usage dashboard for the storage/AI sidebar widgets
	// and the top-bar AI credit meter. The polling lifecycle is owned here so
	// any workspace surface that mounts the sidebar gets refreshed data.
	let stopUsagePolling: (() => void) | null = null;
	// Performance analytics shares the usage polling lifecycle: the dashboard
	// analytics section reads perfAnalyticsStore.aggregate (anonymized, all-members)
	// for REAL per-dimension performance + ROI. Same workspace id, same cadence.
	let stopPerfPolling: (() => void) | null = null;
	// Poll the protected usage + perf endpoints ONLY while authenticated AND a
	// workspace id exists. billingStore.currentWorkspaceId can outlive logout
	// (it persists in storage/session), so gating on it alone would leak the
	// poll interval — firing /api/usage + /api/perf/workspace against a 401
	// after sign-out. Mirror the notificationsStore pattern: bind both polls to
	// auth + workspace together so no interval survives logout.
	let usageWsId = $derived(isAuthenticated ? billingStore.currentWorkspaceId : null);

	// Seed the active workspace id for billing/usage from the loaded workspace
	// list. Nothing else in the shell writes `manga-editor.currentWorkspaceId`
	// (or calls setCurrentWorkspaceId), so without this the billing/usage pages
	// and Settings links land with `wsId === null` and show the "no workspace
	// selected" warning while pricing checkout opens the create-workspace modal.
	$effect(() => {
		const activeId = workspacesStore.currentWorkspace?.workspaceId ?? null;
		if (activeId && activeId !== billingStore.currentWorkspaceId) {
			billingStore.setCurrentWorkspaceId(activeId);
		}
	});

	onMount(() => {
		// Restore the saved session BEFORE the protected billing/usage loads so a
		// hard reload of the workspace shell does not race AuthAccountMenu's async
		// token restore: if these calls won that race they 401 with no billing
		// retry (usage only recovers on the next poll), leaving logged-in users on
		// mock/empty plan data. init() is idempotent.
		void authStore.init()
			.catch(() => undefined)
			.then(() => {
				void billingStore.loadCatalog();
				void billingStore.loadSubscription();
				// Usage + perf polling is started reactively by the auth+workspace
				// $effect below (single source of truth for the poll lifecycle), so
				// once init() flips authStore.isAuthenticated the effect rebinds and
				// begins polling on its own — no duplicate start needed here.
			});
	});

	$effect(() => {
		// Re-bind usage + perf polling when auth or the active workspace changes.
		// `usageWsId` is null whenever the session is anonymous (see above), so on
		// logout this branch stops + clears both stores and no interval survives.
		stopUsagePolling?.();
		stopPerfPolling?.();
		if (usageWsId) {
			stopUsagePolling = usageStore.startPolling(usageWsId);
			stopPerfPolling = perfAnalyticsStore.startPolling(usageWsId);
		} else {
			stopUsagePolling = null;
			stopPerfPolling = null;
			// Drop any signed-out / workspace-less state so a stale dashboard never
			// lingers and the next poll can only restart under a real session.
			usageStore.reset();
			perfAnalyticsStore.reset();
		}
	});

	onDestroy(() => {
		stopUsagePolling?.();
		stopPerfPolling?.();
	});

	// Sidebar widget values: prefer live usage. Until the workspace usage
	// dashboard is loaded we render an HONEST loading/zero state — NEVER a
	// fabricated quota. A real account must never see invented GB figures.
	let storageUsedBytes = $derived(usageStore.storage?.usedBytes ?? 0);
	let storageLimitBytes = $derived(usageStore.storage?.limitBytes ?? 0);
	let hasLiveStorage = $derived(Boolean(usageStore.dashboard));
	let storagePctValue = $derived(hasLiveStorage ? usageStore.storagePct : 0);
	let storageBand = $derived(usageStore.storageBand);
	let storageStyle = $derived(
		storageBand === "frozen"
			? "background: linear-gradient(90deg,var(--color-ws-rose, #FB7185),#F472B6)"
			: storageBand === "warning"
				? "background: linear-gradient(90deg,var(--color-ws-amber, #FBBF24),#F59E0B)"
				: "background: linear-gradient(90deg,var(--color-ws-green, #34D399),var(--color-ws-accent, #7C5CFF))",
	);
	// Remaining-countdown (issue #3): lead with space LEFT; the bar depletes.
	let storageRemainingBytes = $derived(usageStore.storageRemainingBytes);
	let storageRemainingPct = $derived(hasLiveStorage ? Math.max(0, 100 - storagePctValue) : 0);
	let storageDetailLabel = $derived(
		hasLiveStorage
			? `${msg("sidebar.storageRemaining", "เหลือ")} ${formatBytes(storageRemainingBytes)} / ${formatBytes(storageLimitBytes || undefined)}`
			: msg("sidebar.storageLoading", "Loading storage"),
	);
	let storageUsedDetailLabel = $derived(
		hasLiveStorage ? `${msg("sidebar.storageUsed", "ใช้ไป")} ${formatBytes(storageUsedBytes)}` : "",
	);

	async function openBillingSettings(): Promise<void> {
		await goto("/settings/billing");
	}
	async function openUsageSettings(): Promise<void> {
		await goto("/settings/usage");
	}

	function changeView(view: typeof editorUiStore.workspaceView) {
		if (view === "editor" && !hasProject) {
			projectStore.setStatusMsg(msg("sidebar.msgOpenChapterFirst", "Open or create a chapter before editing pages."));
			return;
		}
		if (view === "editor" && hasProject && totalPages === 0) {
			projectStore.setStatusMsg(msg("sidebar.msgNoPagesYet", "This chapter has no pages yet — choose page images before editing."));
			editorUiStore.openLibrary();
			editorUiStore.openChapterSetup({
				mode: "fill-existing-zero-page",
				projectId: projectStore.project?.projectId ?? "",
				titleKey: editorUiStore.workspaceTitleKey,
			});
			return;
		}

		if (!hasProject && view !== "dashboard" && view !== "inbox" && view !== "tasks" && view !== "library" && view !== "reports") return;

		if (view === "dashboard") {
			editorUiStore.openDashboard();
		} else if (view === "inbox") {
			editorUiStore.openInbox();
		} else if (view === "tasks") {
			editorUiStore.openTasks();
		} else if (view === "reports") {
			editorUiStore.openReports();
		} else if (view === "library") {
			editorUiStore.openLibrary();
		} else if (view === "pages") {
			editorUiStore.openPages();
		} else if (view === "work") {
			editorUiStore.openWorkBoard();
		} else if (view === "review") {
			editorUiStore.openReview();
		} else if (view === "import") {
			editorUiStore.openImportReview();
		} else if (view === "editor") {
			editorUiStore.openEditor();
		}

		queueWorkspaceNavigation({
			view,
			projectId: projectStore.project?.projectId ?? undefined,
			pageIndex: view === "editor" ? currentPageIndex : undefined
		});
	}

	function openLibraryHome(): void {
		editorUiStore.openLibrary();
		queueWorkspaceNavigation({ view: "library" });
	}

	// The Storage Library (asset list/filter/size) is its own top-level route, not an
	// in-shell workspace view, so navigate to it directly.
	let onStorageRoute = $derived(currentPathname === "/storage" || currentPathname.startsWith("/storage/"));
	// Settings (profile/billing/usage/members/…) is also a standalone top-level route
	// group. When the sidebar is mounted on it (the standalone shell), the footer
	// Settings control highlights as the active surface — matching Storage above.
	let onSettingsRoute = $derived(currentPathname === "/settings" || currentPathname.startsWith("/settings/"));
	async function openStorageLibrary(): Promise<void> {
		await goto("/storage");
	}

	function openCurrentStoryLibrary(): void {
		if (!currentStoryKey) {
			projectStore.setStatusMsg(msg("sidebar.msgNoOpenStory", "No open story to select yet."));
			return;
		}
		editorUiStore.openLibrary(currentStoryNavKey);
		editorUiStore.setWorkspaceLanguageKey(null);
		queueWorkspaceNavigation({ view: "title", titleKey: currentStoryNavKey ?? undefined });
	}

	function openCurrentChapterLibrary(): void {
		if (!projectStore.project || !currentChapterSelected) {
			projectStore.setStatusMsg(msg("sidebar.msgSelectChapterFirst", "Select a chapter from the story page before opening the chapter shortcut."));
			return;
		}
		const titleKey = currentStoryNavKey ?? editorUiStore.workspaceTitleKey ?? undefined;
		editorUiStore.openLibrary(titleKey ?? null);
		editorUiStore.setWorkspaceLanguageKey(projectStore.project.targetLang ?? null);
		queueWorkspaceNavigation({
			view: "chapter",
			titleKey,
			projectId: projectStore.project.projectId,
		});
	}

	function clickedDisclosureIcon(event: MouseEvent): boolean {
		return event.target instanceof Element && Boolean(event.target.closest("[data-disclosure-action='toggle']"));
	}

	function activateLibrarySection(event: MouseEvent): void {
		if (clickedDisclosureIcon(event)) {
			librarySubnavOpen = !librarySubnavOpen;
			return;
		}

		librarySubnavOpen = true;
		changeView("library");
	}

	function activateWorkflowSection(event: MouseEvent): void {
		if (clickedDisclosureIcon(event)) {
			workflowSubnavOpen = !workflowSubnavOpen;
			return;
		}

		workflowSubnavOpen = true;
		changeView("editor");
	}

	function openSettings(): void {
		switcherOpen = false;
		editorUiStore.openSettings();
		queueWorkspaceNavigation({ view: "settings" });
	}

	function openWorkspaceSettings(): void {
		// Members now lives in the standalone settings-shell route (not the in-shell
		// "settings" view), so just navigate there — no editorUiStore.openSettings().
		switcherOpen = false;
		void goto("/settings/members");
	}

	function workspaceCreatedAtValue(workspace: WorkspaceRecord): number {
		const value = Date.parse(workspace.createdAt);
		return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
	}

	function selectPersonalFallbackWorkspace(workspaces: WorkspaceRecord[]): WorkspaceRecord | null {
		const owned = workspaces.filter((workspace) => workspace.memberRole === "owner");
		if (owned.length === 0) return workspaces[0] ?? null;
		return owned.reduce((selected, workspace) => (
			workspaceCreatedAtValue(workspace) < workspaceCreatedAtValue(selected) ? workspace : selected
		));
	}

	function leaveDialogCopy(key: string, fallback: string, workspaceName: string): string {
		return msg(key, fallback).replace("{workspaceName}", workspaceName);
	}

	function openLeaveWorkspaceDialog(event: MouseEvent, workspace: WorkspaceRecord): void {
		event.stopPropagation();
		leaveWorkspaceTarget = workspace;
		leaveWorkspaceError = null;
	}

	function closeLeaveWorkspaceDialog(): void {
		if (leaveWorkspaceBusy) return;
		leaveWorkspaceTarget = null;
		leaveWorkspaceError = null;
	}

	async function confirmLeaveWorkspace(): Promise<void> {
		const target = leaveWorkspaceTarget;
		if (!target || leaveWorkspaceBusy) return;
		leaveWorkspaceBusy = true;
		leaveWorkspaceError = null;
		const wasCurrentWorkspace = target.workspaceId === currentWorkspace?.workspaceId;
		try {
			await leaveWorkspace(target.workspaceId);
			const remainingWorkspaces = workspacesStore.workspaces.filter((workspace) => workspace.workspaceId !== target.workspaceId);
			workspacesStore.workspaces = remainingWorkspaces;
			if (wasCurrentWorkspace) {
				const fallbackWorkspace = selectPersonalFallbackWorkspace(remainingWorkspaces);
				projectStore.clearRecentProjects();
				if (fallbackWorkspace) {
					await workspacesStore.switchTo(fallbackWorkspace.workspaceId);
				} else {
					workspacesStore.currentWorkspaceId = null;
				}
			}
			// The membership mutation already succeeded; keep the UI usable even if the
			// follow-up list refresh is temporarily offline.
			await workspacesStore.refresh().catch(() => undefined);
			if (wasCurrentWorkspace) {
				await projectStore.loadRecentProjects({
					background: true,
					silentFailure: true,
					workspaceId: workspacesStore.currentWorkspace?.workspaceId ?? null,
				});
			}
			leaveWorkspaceTarget = null;
			switcherOpen = false;
		} catch (error) {
			leaveWorkspaceError = error instanceof Error && error.message
				? error.message
				: msg("sidebar.leaveWorkspaceFailed", "Couldn't leave the workspace. Please try again.");
		} finally {
			leaveWorkspaceBusy = false;
		}
	}

	async function switchWorkspace(workspaceId: string): Promise<void> {
		switcherOpen = false;
		// Drop the previous workspace's Library listing IMMEDIATELY so its story
		// shelves can't linger under the newly selected workspace (a cross-workspace
		// leak), then switch and reload the Library scoped to the NEW workspace id.
		// `switchTo` updates `workspacesStore.currentWorkspaceId`/localStorage but does
		// not touch the project store, so the clear + scoped reload must happen here.
		projectStore.clearRecentProjects();
		await workspacesStore.switchTo(workspaceId);
		await projectStore.loadRecentProjects({ background: true, silentFailure: true, workspaceId });
	}

	async function createWorkspace(): Promise<void> {
		if (!createWorkspaceName.trim()) return;
		workspaceActionBusy = true;
		createWorkspaceError = null;
		try {
			// `create` switches into the new (empty) workspace; clear + scoped reload so
			// the previous workspace's Library shelves don't linger under it.
			projectStore.clearRecentProjects();
			const created = await workspacesStore.create(createWorkspaceName.trim(), "free");
			createWorkspaceName = "";
			switcherOpen = false;
			await projectStore.loadRecentProjects({
				background: true,
				silentFailure: true,
				workspaceId: created?.workspaceId ?? workspacesStore.currentWorkspace?.workspaceId ?? null,
			});
		} catch (error) {
			// Surface the failure inline and KEEP the popover open + the typed name so the
			// user can fix the issue (e.g. verify email, reconnect) and retry — instead of
			// the create silently failing with no feedback.
			createWorkspaceError = error instanceof Error && error.message
				? error.message
				: msg("sidebar.createWorkspaceFailed", "Couldn't create the workspace. Please try again.");
		} finally {
			workspaceActionBusy = false;
		}
	}

</script>

<aside class="workspace-sidebar-rail w-[240px] h-full flex flex-col gap-4 p-4 flex-shrink-0 border-r overflow-y-auto select-none relative z-[1005]" class:nav-open={editorUiStore.workspaceNavOpen} aria-label={msg("sidebar.railAria", "Main navigation rail")}>
	<!-- Workspace switcher / brand -->
	<div class="ws-switcher-wrap">
		<button
			type="button"
			class="ws-switcher ws-btn-ghost rounded-ws-ctrl flex items-center gap-2.5 px-2.5 py-2 mb-1 text-left w-full"
			aria-haspopup="dialog"
			aria-expanded={switcherOpen}
			onclick={() => switcherOpen = !switcherOpen}
		>
			<span
				class="ws-switcher-mark"
				style={`--workspace-identity-color: ${currentWorkspaceIdentity.color.value}`}
				aria-hidden="true"
			>
				{currentWorkspaceIdentity.initials}
			</span>
			<span class="flex-1 min-w-0">
				<span class="block text-[13px] font-semibold text-ws-ink leading-tight truncate font-sans">{currentWorkspaceName}</span>
				<span class="block text-[11px] text-ws-faint leading-tight">{currentWorkspacePlan}</span>
			</span>
			<svg class="ws-switcher-caret" viewBox="0 0 24 24" fill="none" aria-hidden="true">
				<path d="M7 10l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		</button>
		{#if switcherOpen}
			<!-- คลิกนอกแผง = ปิด (สครีมเต็มจอ) -->
			<button type="button" class="ws-switcher-scrim" aria-label={msg("sidebar.closeSwitcher", "ปิดตัวสลับบ้าน")} onclick={() => switcherOpen = false}></button>
			<div
				class="ws-switcher-popover"
				role="dialog"
				aria-modal="true"
				aria-label={msg("sidebar.workspaceSwitcherAria", "Workspace switcher")}
				use:dialogFocus={{ onEscape: () => { switcherOpen = false; } }}
			>
				<div class="ws-popover-head">
					<span>{msg("sidebar.workspaceSwitcherLabel", "สลับบ้าน")}</span>
					<button type="button" class="ws-popover-close" aria-label={msg("sidebar.closeSwitcher", "ปิดตัวสลับบ้าน")} onclick={() => switcherOpen = false}>×</button>
				</div>
				<div class="ws-switcher-list">
					{#each switcherSections as section (section.id)}
						{#if section.workspaces.length > 0}
							{#if switcherSections.some((other) => other.id !== section.id && other.workspaces.length > 0)}
								<div class="ws-popover-section-label">{section.label}</div>
							{/if}
							{#each section.workspaces as workspace (workspace.workspaceId)}
								{@const identity = workspaceIdentityFor({ workspaceId: workspace.workspaceId, name: workspace.name })}
								{@const isCurrent = workspace.workspaceId === currentWorkspace?.workspaceId}
								<button
									type="button"
									class:active={isCurrent}
									class="ws-workspace-option"
									aria-current={isCurrent ? "true" : undefined}
									onclick={() => switchWorkspace(workspace.workspaceId)}
								>
									<span
										class="ws-workspace-option-mark"
										style={`--workspace-identity-color: ${identity.color.value}`}
										aria-hidden="true"
									>
										{identity.initials}
									</span>
									<span class="ws-workspace-option-copy">
										<span>{workspace.name}</span>
										<small>{workspaceRoleLabelFor(workspace.memberRole, workspace.memberScope)} · {workspace.planId}</small>
									</span>
									{#if isCurrent}
										<svg class="ws-option-check" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 13l4 4 10-10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
									{/if}
								</button>
								{#if workspace.memberRole !== "owner"}
									<button
										type="button"
										class="ws-workspace-leave-option"
										aria-label={leaveDialogCopy("sidebar.leaveWorkspaceAria", "Leave {workspaceName}", workspace.name)}
										onclick={(event) => openLeaveWorkspaceDialog(event, workspace)}
									>
										{msg("sidebar.leaveWorkspaceButton", "ออกจากบ้านนี้")}
									</button>
								{/if}
							{/each}
						{/if}
					{/each}
					{#if workspacesStore.workspaces.length === 0}
						<div class="ws-switcher-empty">{msg("sidebar.noWorkspaces", "No workspaces from backend yet")}</div>
					{/if}
				</div>
				<div class="ws-create-workspace">
					<input
						bind:value={createWorkspaceName}
						oninput={() => { if (createWorkspaceError) createWorkspaceError = null; }}
						placeholder={msg("sidebar.newWorkspaceName", "New workspace name")}
						aria-label={msg("sidebar.newWorkspaceName", "New workspace name")}
						aria-invalid={Boolean(createWorkspaceError)}
					/>
					{#if createWorkspaceName.trim()}
						<button type="button" onclick={createWorkspace} disabled={workspaceActionBusy}>
							{workspaceActionBusy ? msg("sidebar.creating", "Creating...") : msg("sidebar.create", "Create")}
						</button>
					{:else}
						<span>{msg("sidebar.nameWorkspace", "Name the workspace")}</span>
					{/if}
				</div>
					{#if createWorkspaceError}
						<div class="ws-create-workspace-error" role="alert" aria-live="assertive">
							{createWorkspaceError}
						</div>
					{/if}
					<button type="button" class="ws-settings-link" onclick={openWorkspaceSettings}>{msg("sidebar.workspaceSettings", "Workspace settings")}</button>
					{#if leaveWorkspaceTarget}
						<div
							class="ws-leave-dialog"
							role="alertdialog"
							aria-modal="true"
							aria-labelledby="workspace-leave-dialog-title"
							aria-describedby="workspace-leave-dialog-copy"
							use:dialogFocus={{ onEscape: closeLeaveWorkspaceDialog, busy: leaveWorkspaceBusy }}
						>
							<h2 id="workspace-leave-dialog-title">{msg("sidebar.leaveWorkspaceDialogTitle", "Leave this workspace?")}</h2>
							<p id="workspace-leave-dialog-copy">
								{leaveDialogCopy("sidebar.leaveWorkspaceDialogBody", "You will lose access to {workspaceName}. You can rejoin only if someone invites you again.", leaveWorkspaceTarget.name)}
							</p>
							{#if leaveWorkspaceError}
								<p class="ws-leave-error" role="alert">{leaveWorkspaceError}</p>
							{/if}
							<div class="ws-leave-actions">
								<button type="button" class="ws-leave-cancel" disabled={leaveWorkspaceBusy} onclick={closeLeaveWorkspaceDialog}>
									{msg("sidebar.leaveWorkspaceCancel", "Cancel")}
								</button>
								<button type="button" class="ws-leave-confirm" disabled={leaveWorkspaceBusy} onclick={() => void confirmLeaveWorkspace()}>
									{leaveWorkspaceBusy ? msg("sidebar.leaveWorkspaceLeaving", "Leaving...") : msg("sidebar.leaveWorkspaceConfirm", "Confirm leave")}
								</button>
							</div>
						</div>
					{/if}
				</div>
			{/if}
		</div>

	<!-- Global content search ("/") — find stories / chapters / workspaces -->
	<button
		type="button"
		class="ws-command-trigger flex items-center gap-2 w-full min-h-9 px-2.5 rounded-ws-ctrl border text-left transition-colors"
		onclick={() => searchStore.openSearch()}
		title={`${msg("search.triggerHint", "Search stories, chapters & workspaces")} (/)`}
		aria-label={`${msg("search.triggerHint", "Search stories, chapters & workspaces")} (/)`}
		aria-keyshortcuts="/"
	>
		<svg class="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
			<circle cx="11" cy="11" r="7" stroke-width="1.9"/>
			<path d="m21 21-4.3-4.3" stroke-width="1.9" stroke-linecap="round"/>
		</svg>
		<span class="flex-1 text-[12.5px] font-medium truncate">{msg("search.trigger", "Search")}</span>
		<kbd class="ws-command-kbd">/</kbd>
	</button>

	<!-- Command palette (⌘K) action launcher -->
	<button
		type="button"
		class="ws-command-trigger flex items-center gap-2 w-full min-h-9 px-2.5 rounded-ws-ctrl border text-left transition-colors"
		onclick={() => commandPaletteStore.openPalette()}
		title={`${msg("commandPalette.triggerHint", "Run a command or jump to…")} (${commandPaletteShortcut})`}
		aria-label={`${msg("commandPalette.triggerHint", "Run a command or jump to…")} (${commandPaletteShortcut})`}
		aria-keyshortcuts="Meta+K Control+K"
	>
		<svg class="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
			<rect x="4" y="4" width="16" height="16" rx="3" stroke-width="1.9"/>
			<path d="M9 9h6v6H9z" stroke-width="1.4" stroke-linejoin="round"/>
		</svg>
		<span class="flex-1 text-[12.5px] font-medium truncate">{msg("commandPalette.trigger", "Commands")}</span>
		<kbd class="ws-command-kbd">{commandPaletteShortcut}</kbd>
	</button>

	<!-- Main Navigation Links -->
	<nav class="flex flex-col gap-1 flex-1" aria-label={msg("sidebar.controlsAria", "Workspace controls")}>
		<div class="sidebar-section-head">
			<span>{msg("sidebar.sectionControls", "WORKSPACE CONTROLS")}</span>
		</div>

		<button
			type="button"
			aria-label={msg("sidebar.dashboard", "Dashboard")}
			class="sidebar-nav-btn ws-nav-item min-h-10 flex items-center gap-3 px-3 py-2 rounded-ws-ctrl text-ws-text hover:text-ws-ink transition-all duration-200 text-left text-[13.5px] font-medium w-full border border-transparent {activeView === 'dashboard' ? 'active ws-nav-active !text-ws-ink' : ''}"
			onclick={() => changeView("dashboard")}
			>
				<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
					<rect x="3" y="3" width="7" height="9" rx="1.5"/>
					<rect x="14" y="3" width="7" height="5" rx="1.5"/>
					<rect x="14" y="12" width="7" height="9" rx="1.5"/>
					<rect x="3" y="16" width="7" height="5" rx="1.5"/>
				</svg>
				<span class="font-sans">{msg("sidebar.dashboard", "Dashboard")}</span>
		</button>

		<button
			type="button"
			aria-label={msg("sidebar.inbox", "Inbox")}
			class="sidebar-nav-btn ws-nav-item min-h-10 flex items-center gap-3 px-3 py-2 rounded-ws-ctrl text-ws-text hover:text-ws-ink transition-all duration-200 text-left text-[13.5px] font-medium w-full border border-transparent {activeView === 'inbox' ? 'active ws-nav-active !text-ws-ink' : ''}"
			onclick={() => changeView("inbox")}
			title={msg("sidebar.inboxTitle", "Open attention items across this workspace")}
		>
			<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
				<path d="M4 4h16l-2 10H6L4 4Z"/>
				<path d="M6 14v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-3"/>
				<path d="M9 10h6"/>
			</svg>
			<span class="font-sans">{msg("sidebar.inbox", "Inbox")}</span>
		</button>

		<button
			type="button"
			aria-label={msg("sidebar.tasks", "My tasks")}
			class="sidebar-nav-btn ws-nav-item min-h-10 flex items-center gap-3 px-3 py-2 rounded-ws-ctrl text-ws-text hover:text-ws-ink transition-all duration-200 text-left text-[13.5px] font-medium w-full border border-transparent {activeView === 'tasks' ? 'active ws-nav-active !text-ws-ink' : ''}"
			onclick={() => changeView("tasks")}
			title={msg("sidebar.tasksTitle", "Open every task assigned to you in this workspace")}
		>
			<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
				<path d="M9 11l2 2 4-4"/>
				<path d="M9 17h6"/>
				<rect x="4" y="3" width="16" height="18" rx="2.5"/>
			</svg>
			<span class="font-sans">{msg("sidebar.tasks", "My tasks")}</span>
		</button>

		<button
			type="button"
			aria-label={msg("sidebar.library", "Library")}
			aria-expanded={librarySubnavOpen}
			aria-controls="library-sidebar-subnav"
			class="sidebar-nav-btn sidebar-nav-disclosure ws-nav-item min-h-10 flex items-center gap-3 px-3 py-2 rounded-ws-ctrl text-ws-text hover:text-ws-ink transition-all duration-200 text-left text-[13.5px] font-medium w-full border border-transparent {activeView === 'library' ? 'active ws-nav-active !text-ws-ink' : ''}"
			onclick={activateLibrarySection}
		>
			<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
				<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/>
				<path d="M6 6h10M6 10h10M6 14h10"/>
			</svg>
			<span class="font-sans">{msg("sidebar.library", "Library")}</span>
			<span class="sidebar-disclosure-hit" data-disclosure-action="toggle" aria-hidden="true">
				<svg class="sidebar-disclosure-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
					<path d={librarySubnavOpen ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"}/>
				</svg>
			</span>
		</button>
			{#if librarySubnavOpen}
				<div id="library-sidebar-subnav" class="sidebar-subnav-group" aria-label={msg("sidebar.librarySubnavAria", "Library sub-items")}>
					<div class="sidebar-subnav-label">{msg("sidebar.story", "Story")}</div>
					<button
						type="button"
						aria-label={msg("sidebar.libraryOverview", "Library overview")}
						class="sidebar-subnav-btn {libraryViewActive && onOverviewRoute ? 'active' : ''}"
						onclick={openLibraryHome}
					>
						<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
							<rect x="3" y="4" width="7" height="7" rx="1.5"/>
							<rect x="14" y="4" width="7" height="7" rx="1.5"/>
							<rect x="3" y="15" width="7" height="5" rx="1.5"/>
							<rect x="14" y="15" width="7" height="5" rx="1.5"/>
						</svg>
						<span class="subnav-copy">
							<span>{msg("sidebar.overview", "Overview")}</span>
							<small>{msg("sidebar.overviewMeta", "Covers · stories · recent chapters")}</small>
						</span>
					</button>
					{#if currentStoryKey}
						<button
							type="button"
							aria-label={msg("sidebar.openStory", "Open story in library")}
							class="sidebar-subnav-btn {libraryViewActive && onStoryRoute ? 'active' : ''}"
							onclick={openCurrentStoryLibrary}
						>
							<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
								<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/>
								<path d="M8 6h8M8 10h7M8 14h5"/>
							</svg>
							<span class="subnav-copy">
								<span>{msg("sidebar.openStoryLabel", "Open story")}</span>
								<small>{currentStoryLabel}</small>
							</span>
						</button>
					{:else}
						<!-- First-run: no story selected yet — route to the Library overview to
						     pick/create a story instead of showing a disabled dead control. -->
						<button
							type="button"
							aria-label={msg("sidebar.browseStories", "Browse stories in the Library")}
							class="sidebar-subnav-btn sidebar-subnav-empty"
							onclick={openLibraryHome}
						>
							<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
								<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/>
								<path d="M8 6h8M8 10h7M8 14h5"/>
							</svg>
							<span class="subnav-copy">
								<span>{msg("sidebar.browseStoriesLabel", "Browse stories")}</span>
								<small>{msg("sidebar.pickStory", "Pick a story from the overview")}</small>
							</span>
						</button>
					{/if}
					<div class="sidebar-subnav-label">{msg("sidebar.chapter", "Chapter")}</div>
					{#if currentChapterSelected}
						<button
							type="button"
							aria-label={msg("sidebar.openChapterInLibrary", "Open chapter in library")}
							class="sidebar-subnav-btn {libraryViewActive && onChapterRoute ? 'active' : ''}"
							onclick={openCurrentChapterLibrary}
						>
							<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
								<rect x="4" y="3" width="16" height="18" rx="2"/>
								<path d="M8 7h8M8 11h8M8 15h5"/>
							</svg>
							<span class="subnav-copy">
								<span>{msg("sidebar.openChapterLabel", "Open chapter")}</span>
								<small>{currentChapterLabel}</small>
							</span>
						</button>
					{:else}
						<!-- First-run: no chapter open yet — route to the Library overview to
						     pick/create a chapter instead of showing a disabled dead control. -->
						<button
							type="button"
							aria-label={msg("sidebar.browseChapters", "Browse chapters in the Library")}
							class="sidebar-subnav-btn sidebar-subnav-empty"
							onclick={openLibraryHome}
						>
							<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
								<rect x="4" y="3" width="16" height="18" rx="2"/>
								<path d="M8 7h8M8 11h8M8 15h5"/>
							</svg>
							<span class="subnav-copy">
								<span>{msg("sidebar.browseChaptersLabel", "Find a chapter")}</span>
								<small>{msg("sidebar.pickChapter", "Pick a chapter from the story page first")}</small>
							</span>
						</button>
					{/if}
				</div>
			{/if}

		<!-- Reports (workspace analytics roll-up) -->
		<button
			type="button"
			aria-label={msg("sidebar.reports", "Reports")}
			class="sidebar-nav-btn ws-nav-item min-h-10 flex items-center gap-3 px-3 py-2 rounded-ws-ctrl text-ws-text hover:text-ws-ink transition-all duration-200 text-left text-[13.5px] font-medium w-full border border-transparent {activeView === 'reports' ? 'active ws-nav-active !text-ws-ink' : ''}"
			onclick={() => changeView("reports")}
		>
			<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="m18.7 8-5.1 5.2-2.8-2.7L7 14.3"/></svg>
			<span class="font-sans">{msg("sidebar.reports", "Reports")}</span>
		</button>

		<!-- Storage Library (workspace asset list / filter / size — its own route) -->
		<button
			type="button"
			aria-label={msg("sidebar.storageLibrary", "Storage")}
			class="sidebar-nav-btn ws-nav-item min-h-10 flex items-center gap-3 px-3 py-2 rounded-ws-ctrl text-ws-text hover:text-ws-ink transition-all duration-200 text-left text-[13.5px] font-medium w-full border border-transparent {onStorageRoute ? 'active ws-nav-active !text-ws-ink' : ''}"
			onclick={() => void openStorageLibrary()}
		>
			<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
				<rect x="3" y="3" width="18" height="18" rx="2"/>
				<path d="m3 14 4-4 5 5"/>
				<path d="m14 13 3-3 4 4"/>
				<circle cx="8.5" cy="8" r="1.6"/>
			</svg>
			<span class="font-sans">{msg("sidebar.storageLibrary", "Storage")}</span>
		</button>

		<div class="h-px bg-white/[0.07] my-2.5 mx-2"></div>

		<div class="sidebar-section-head">
			<span>{msg("sidebar.sectionWorkflow", "ACTIVE CHAPTER WORKFLOW")}</span>
		</div>

		<button
			type="button"
			aria-label={hasProject ? msg("sidebar.workflowForChapter", "Current chapter workflow") : msg("sidebar.workspaceArea", "Workspace")}
			aria-expanded={workflowSubnavOpen}
			aria-controls="workflow-sidebar-subnav"
			class="sidebar-nav-btn sidebar-nav-disclosure ws-nav-item min-h-10 flex items-center gap-3 px-3 py-2 rounded-ws-ctrl text-ws-text hover:text-ws-ink transition-all duration-200 text-left text-[13.5px] font-medium w-full border border-transparent {workflowViewActive ? 'active ws-nav-active !text-ws-ink' : ''}"
			onclick={activateWorkflowSection}
			title={!hasProject ? msg("sidebar.openChapterFirstTitle", "Open a chapter first") : `${currentStoryLabel} · ${currentChapterLabel}`}
		>
			<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
				<path d="M12 20h9"/>
				<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
			</svg>
			<!-- When a chapter is open this reads as the active chapter so the
			     workflow tools (incl. editor) below are clearly nested under it
			     (Workspace > Story > Chapter > tools). Issue #11. -->
			<span class="font-sans truncate">{hasProject ? currentChapterLabel : msg("sidebar.workspaceArea", "Workspace")}</span>
			<span class="sidebar-disclosure-hit" data-disclosure-action="toggle" aria-hidden="true">
				<svg class="sidebar-disclosure-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
					<path d={workflowSubnavOpen ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"}/>
				</svg>
			</span>
		</button>
			{#if workflowSubnavOpen}
				<div id="workflow-sidebar-subnav" class="sidebar-subnav-group" aria-label={msg("sidebar.workflowSubnavAria", "Current chapter sub-items")}>
					{#if hasProject}
						<button
							type="button"
							aria-label={msg("sidebar.editorTool", "Editor")}
							class="sidebar-subnav-btn {activeView === 'editor' ? 'active' : ''}"
							onclick={() => changeView("editor")}
							title={msg("sidebar.editorToolTitle", "Edit this chapter's pages")}
						>
							<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
								<path d="M12 20h9"/>
								<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
							</svg>
							<span class="subnav-copy">
								<span>{msg("sidebar.editorToolLabel", "Editor")}</span>
								<small>{msg("sidebar.editorToolMeta", "Edit pages")}</small>
							</span>
						</button>

						<button
							type="button"
							aria-label={msg("sidebar.importReview", "Import / Preview")}
							class="sidebar-subnav-btn {activeView === 'import' ? 'active' : ''}"
							onclick={() => changeView("import")}
							title={msg("sidebar.importReviewTitle", "Import and check the preview queue")}
						>
							<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
								<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
								<polyline points="17 8 12 3 7 8"/>
								<line x1="12" y1="3" x2="12" y2="15"/>
							</svg>
							<span class="subnav-copy">
								<span>{msg("sidebar.importReviewLabel", "Import / Preview")}</span>
								<small>Import</small>
							</span>
						</button>

						<button
							type="button"
							aria-label={msg("sidebar.reviewWork", "Review (read / review)")}
							class="sidebar-subnav-btn {activeView === 'review' ? 'active' : ''}"
							onclick={() => changeView("review")}
							title={msg("sidebar.reviewWorkTitle", "Read and review the chapter full-page")}
						>
							<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
								<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
								<path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
							</svg>
							<span class="subnav-copy">
								<span>{msg("sidebar.reviewWorkLabel", "Review")}</span>
								<small>{msg("sidebar.reviewWorkMeta", "Read / review")}</small>
							</span>
						</button>

						<button
							type="button"
							aria-label={msg("sidebar.pagesMap", "Chapter map (Pages)")}
							class="sidebar-subnav-btn {activeView === 'pages' ? 'active' : ''}"
							onclick={() => changeView("pages")}
							title={msg("sidebar.pagesMapTitle", "All chapter pages queue")}
						>
							<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
								<rect x="3" y="3" width="18" height="18" rx="2.5" ry="2.5"/>
								<line x1="9" y1="3" x2="9" y2="21"/>
								<line x1="15" y1="3" x2="15" y2="21"/>
							</svg>
							<span class="subnav-copy">
								<span>{msg("sidebar.pagesExport", "Pages / Export")}</span>
								<small>{totalPages} {msg("sidebar.pages", "pages")}</small>
							</span>
						</button>

						<button
							type="button"
							aria-label={msg("sidebar.teamBoard", "Team board (Kanban)")}
							class="sidebar-subnav-btn {activeView === 'work' ? 'active' : ''}"
							onclick={() => changeView("work")}
							title={msg("sidebar.teamBoardTitle", "Team task board")}
						>
							<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
								<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
								<circle cx="9" cy="7" r="4"/>
								<path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
								<path d="M16 3.13a4 4 0 0 1 0 7.75"/>
							</svg>
							<span class="subnav-copy">
								<span>{msg("sidebar.teamBoardLabel", "Team board")}</span>
								<small>{msg("sidebar.assignedWork", "Assigned work")}</small>
							</span>
						</button>
					{:else}
						<button
							type="button"
							aria-label={msg("sidebar.openLibraryToPick", "Open the library to pick or create a chapter")}
							class="sidebar-subnav-btn sidebar-subnav-empty"
							onclick={openLibraryHome}
						>
							<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
								<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/>
								<path d="M8 7h8M8 11h6M8 15h5"/>
							</svg>
							<span class="subnav-copy">
								<span>{msg("sidebar.pickOrCreateChapter", "Pick or create a chapter")}</span>
								<small>{msg("sidebar.openLibraryFirst", "Open the library before entering the workspace")}</small>
							</span>
						</button>
					{/if}
				</div>
			{/if}
	</nav>

	<!-- Sidebar Widgets Section -->
	<div class="flex flex-col gap-4 mt-auto border-t border-white/[0.07] pt-4">
		<!-- Storage usage widget — live when workspace+usage are loaded -->
		<div class="flex flex-col gap-2 px-1">
			<div class="flex justify-between items-center text-[10px] font-semibold text-ws-faint">
				<span class="font-sans uppercase tracking-wider">{msg("sidebar.storage", "Storage")}</span>
				<!-- Remaining-countdown (issue #3): show % LEFT, bar depletes. The
				     "เหลือ" qualifier disambiguates the flipped number (15% LEFT vs
				     the old 85% USED reading of the same glyph). -->
				<span class="text-ws-text font-mono">{msg("sidebar.storageRemaining", "เหลือ")} {storageRemainingPct.toFixed(1)}%</span>
			</div>
			<div class="ws-track w-full h-1.5">
				<div class="ws-fill" style={`width: ${Math.min(100, storageRemainingPct)}%; ${storageStyle}`}></div>
			</div>
			<div class="flex justify-between items-center mt-1">
				<span class="text-[10px] text-ws-text font-medium font-sans" title={storageUsedDetailLabel}>{storageDetailLabel}</span>
				<button
					type="button"
					class="min-h-10 text-[9px] font-bold text-ws-accent hover:text-ws-ink transition-colors uppercase tracking-wider bg-transparent p-0 border-0"
					onclick={() => void openUsageSettings()}
				>{msg("sidebar.manageStorage", "Manage storage")}</button>
			</div>
			{#if usageStore.hasResolvedPlan || billingStore.subscription || billingStore.publicPlanKey}
				<div class="flex justify-between items-center mt-1">
					<!-- Same resolved plan as the storage/credit meters above, so this
					     footer badge can't show "Free" beside a Studio allowance. -->
					<PlanBadge plan={usageStore.resolvedPlanKey ?? billingStore.publicPlanKey ?? "free"} size="xs" />
					<button
						type="button"
						class="min-h-10 text-[9px] font-bold text-ws-accent hover:text-ws-ink transition-colors uppercase tracking-wider bg-transparent p-0 border-0"
						onclick={() => void openBillingSettings()}
					>Billing</button>
				</div>
			{/if}
		</div>

		<!-- Team management widget -->
		<div class="flex flex-col gap-2 px-1 mt-1">
			<span class="text-[10px] font-semibold text-ws-faint uppercase tracking-wider block font-sans">{teamLabel}</span>
			<div class="flex justify-between items-center">
				<AvatarStack
					items={memberAvatarItems}
					ariaLabel={msg("sidebar.yourTeam", "Your team")}
				/>
				<button type="button" class="min-h-10 text-[9px] font-bold text-ws-accent hover:text-ws-ink transition-colors uppercase tracking-wider bg-transparent p-0 border-0" onclick={openSettings}>{msg("sidebar.manageTeam", "Manage team")}</button>
			</div>
		</div>
	</div>

	<!-- User / plan button + account menu -->
	<div class="ws-user-wrap relative mt-1">
		{#if !isAuthenticated}
			<!-- Anonymous: in-context sign-in / get-started CTAs that open the AuthModal
				(no full-page navigation to /login). -->
			<div class="ws-auth-cta">
				<button type="button" class="ws-auth-cta-primary" onclick={() => openAuthModal("register")}>
					{msg("sidebar.getStartedFree", "Get started free")}
				</button>
				<button type="button" class="ws-auth-cta-secondary" onclick={() => openAuthModal("login")}>
					{msg("sidebar.signIn", "Sign in")}
				</button>
			</div>
		{:else}
		<button
			type="button"
			class="ws-user-btn ws-btn-ghost rounded-ws-ctrl flex items-center gap-2.5 px-2 py-2 w-full text-left"
			class:active={accountMenuOpen}
			aria-haspopup="menu"
			aria-expanded={accountMenuOpen}
			aria-label={`${msg("sidebar.account", "Account")} ${authRoleLabel} ${authName}`}
			onclick={() => (accountMenuOpen = !accountMenuOpen)}
		>
			<span class="ws-user-avatar">{authInitial}</span>
			<span class="flex-1 min-w-0">
				<span class="block text-[13px] font-semibold text-ws-ink leading-tight truncate">{authName}</span>
				<span class="block text-[11px] text-ws-green leading-tight">{currentWorkspacePlan}</span>
			</span>
			<svg class="ws-user-caret" viewBox="0 0 24 24" fill="none" aria-hidden="true">
				<path d="M8 7l4-3 4 3M8 17l4 3 4-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		</button>

		{#if accountMenuOpen}
			<button
				type="button"
				class="ws-user-backdrop"
				aria-label={msg("sidebar.closeAccountMenu", "Close account menu")}
				onclick={() => (accountMenuOpen = false)}
			></button>
			<div class="ws-user-popover" role="menu" aria-label={msg("sidebar.accountAndSignOut", "Account and sign out")}>
				<div class="ws-user-card">
					<span class="ws-user-card-name">{authName}</span>
					{#if authEmail}
						<span class="ws-user-card-email">{authEmail}</span>
					{/if}
					<span class="ws-user-card-role">{msg("sidebar.role", "Role")} {authRoleLabel}</span>
				</div>
				<button type="button" class="ws-user-settings" onclick={() => { accountMenuOpen = false; openSettings(); }}>
					{msg("sidebar.accountSettings", "Account settings")}
				</button>
				{#if signOutBusy}
					<span class="ws-user-signout busy" aria-label={msg("sidebar.signingOut", "Signing out")}>{msg("sidebar.signingOutEllipsis", "Signing out…")}</span>
				{:else}
					<button type="button" class="ws-user-signout" onclick={handleSidebarSignOut}>
						{msg("sidebar.signOut", "Sign out")}
					</button>
				{/if}
			</div>
		{/if}
		{/if}
	</div>

	<!-- Sidebar Settings Footer -->
	<div class="sidebar-pinned-footer flex items-center justify-between border-t border-white/[0.07] pt-3.5 mt-1">
		<button type="button" class="ws-settings-footer-btn min-h-10 flex items-center gap-2.5 text-ws-text hover:text-ws-ink transition-colors text-[13px] font-medium bg-transparent border-0 p-0 cursor-pointer {onSettingsRoute ? 'active' : ''}" onclick={openSettings}>
			<svg class="w-4 h-4 opacity-80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="12" cy="12" r="3"/>
				<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
			</svg>
			<span class="font-sans">{msg("sidebar.settings", "Settings")}</span>
		</button>

		<div class="inline-flex items-center gap-1 bg-ws-green/15 border border-ws-green/20 text-ws-green text-[8px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full">
			<svg class="nav-icon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor">
				<polyline points="20 6 9 17 4 12"/>
			</svg>
			<span class="font-sans text-[7.5px]">VS Active</span>
		</div>
	</div>
</aside>

<style>
	.workspace-sidebar-rail {
		background: var(--color-ws-bg, #0B0B0F);
		border-right-color: var(--ws-hair, rgba(255, 255, 255, 0.07));
		color: var(--color-ws-text, #9a9aa8);
		transition: transform 0.24s cubic-bezier(0.4, 0, 0.2, 1);
	}

	/* ⌘K affordance in the sidebar: a quiet search field that opens the palette. */
	.ws-command-trigger {
		border-color: rgba(255, 255, 255, 0.09);
		background: rgba(255, 255, 255, 0.03);
		color: var(--color-ws-text, #9a9aa8);
		cursor: pointer;
	}

	.ws-command-trigger:hover,
	.ws-command-trigger:focus-visible {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 50%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 10%, transparent);
		color: var(--color-ws-ink, #ececf2);
		outline: none;
	}

	.ws-command-kbd {
		flex-shrink: 0;
		padding: 1px 6px;
		border: 1px solid rgba(255, 255, 255, 0.14);
		border-radius: 6px;
		background: rgba(0, 0, 0, 0.35);
		color: inherit;
		font-size: 10px;
		font-weight: 700;
		font-family: inherit;
		line-height: 1.5;
	}

	/* ── Off-canvas drawer below the lap/tablet breakpoint ──
	   Wide: in-flow 240px rail (default). Narrow: fixed, slides in over
	   the content; the shell renders a hamburger + backdrop to drive it.
	   Breakpoint includes iPad-landscape (1024px) so it gets the drawer instead
	   of an in-flow rail that would leave only ~784px for content. */
	@media (max-width: 1024px) {
		.workspace-sidebar-rail {
			position: fixed;
			inset: 0 auto 0 0;
			width: min(280px, 84vw);
			transform: translateX(-104%);
			box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
			z-index: 1200;
		}
		.workspace-sidebar-rail.nav-open {
			transform: translateX(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.workspace-sidebar-rail {
			transition: none;
		}
	}

	:global(.workspace-sidebar-rail button) {
		min-width: 40px;
	}

	/* workspace switcher (brand) */
	.ws-switcher-wrap {
		position: relative;
	}

	.ws-switcher {
		min-height: 0;
	}

	.ws-switcher-mark {
		position: relative;
		width: 28px;
		height: 28px;
		flex-shrink: 0;
		border-radius: 9px;
		display: grid;
		place-items: center;
		border: 1px solid color-mix(in srgb, var(--workspace-identity-color) 48%, rgba(255, 255, 255, 0.24));
		background:
			linear-gradient(135deg,
				color-mix(in srgb, var(--workspace-identity-color) 86%, var(--color-ws-ink, #ececf2) 14%),
				color-mix(in srgb, var(--workspace-identity-color) 58%, var(--color-ws-bg, #0b0b0f) 42%));
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.22),
			0 10px 22px -16px var(--workspace-identity-color);
		color: var(--color-ws-ink, #ececf2);
		font-size: 10px;
		font-weight: 950;
		letter-spacing: 0;
		line-height: 1;
	}

	.ws-switcher-caret {
		width: 14px;
		height: 14px;
		flex-shrink: 0;
		color: var(--color-ws-faint, #6b6b78);
	}

	/* Pin Settings to the bottom of the rail: it stays put while the nav list above it
	   scrolls (the rail itself is the scroll container). The negative margin + bg let it
	   span the rail's padding and hide content scrolling beneath it. */
	.sidebar-pinned-footer {
		position: sticky;
		bottom: 0;
		margin-left: -1rem;
		margin-right: -1rem;
		padding-left: 1rem;
		padding-right: 1rem;
		padding-bottom: 0.5rem;
		background: var(--color-ws-bg, #0B0B0F);
		z-index: 5;
	}

	.ws-switcher-popover {
		position: absolute;
		left: 0;
		right: 0;
		top: calc(100% + 6px);
		z-index: 20;
		max-height: calc(100vh - 96px);
		overflow-y: auto;
		display: grid;
		gap: 10px;
		padding: 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-line, #a6b7dc) 18%, transparent);
		border-radius: 10px;
		background: rgba(13, 17, 26, 0.98);
		box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
	}

	.ws-popover-head span {
		display: block;
		color: var(--color-ws-accent, #8fb8ff);
		font-size: 9px;
		font-weight: 900;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	.ws-popover-head strong {
		display: block;
		margin-top: 2px;
		overflow: hidden;
		color: var(--color-ws-ink, #ececf2);
		font-size: 13px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ws-switcher-list {
		display: grid;
		gap: 4px;
		max-height: 180px;
		overflow: auto;
	}

	.ws-switcher-list button,
	.ws-settings-link,
	.ws-create-workspace button,
	.ws-create-workspace span {
		min-height: 40px;
		border-radius: 8px;
	}

	.ws-switcher-list button {
		display: grid;
		gap: 2px;
		width: 100%;
		padding: 8px 9px;
		border: 1px solid color-mix(in srgb, var(--color-ws-line, #a6b7dc) 9%, transparent);
		background: rgba(255, 255, 255, 0.035);
		color: var(--color-ws-text, #9a9aa8);
		text-align: left;
	}

	.ws-switcher-list button.ws-workspace-option {
		grid-template-columns: 28px minmax(0, 1fr);
		align-items: center;
		column-gap: 8px;
	}

	.ws-switcher-list button.active {
		border-color: rgba(115, 233, 196, 0.24);
		background: rgba(115, 233, 196, 0.1);
		color: var(--color-ws-ink, #ececf2);
	}

	.ws-switcher-list button span,
	.ws-switcher-list button small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ws-switcher-list button span {
		font-size: 12px;
		font-weight: 800;
	}

	.ws-workspace-option-copy {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.ws-workspace-option-mark {
		width: 26px;
		height: 26px;
		min-width: 26px;
		border-radius: 8px;
		display: grid;
		place-items: center;
		overflow: visible;
		border: 1px solid color-mix(in srgb, var(--workspace-identity-color) 42%, rgba(255, 255, 255, 0.18));
		background:
			linear-gradient(135deg,
				color-mix(in srgb, var(--workspace-identity-color) 82%, var(--color-ws-ink, #ececf2) 18%),
				color-mix(in srgb, var(--workspace-identity-color) 48%, var(--color-ws-bg, #0b0b0f) 52%));
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18);
		color: var(--color-ws-ink, #ececf2);
		font-size: 9.5px;
		font-weight: 950;
		letter-spacing: 0;
		line-height: 1;
		text-overflow: clip;
		white-space: normal;
	}

	.ws-switcher-list button small,
	.ws-switcher-empty {
		color: var(--color-ws-faint, #6b6b78);
		font-size: 10px;
	}

	.ws-switcher-list button.ws-workspace-leave-option {
		min-height: 34px;
		margin: -1px 0 6px 34px;
		padding: 6px 9px;
		border-color: color-mix(in srgb, var(--color-ws-rose, #FB7185) 20%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose, #FB7185) 8%, transparent);
		color: #fda4af;
		font-size: 10.5px;
		font-weight: 850;
		text-align: center;
	}

	.ws-switcher-list button.ws-workspace-leave-option:hover,
	.ws-switcher-list button.ws-workspace-leave-option:focus-visible {
		border-color: color-mix(in srgb, var(--color-ws-rose, #FB7185) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose, #FB7185) 14%, transparent);
		color: #ffe4e6;
		outline: none;
	}

	.ws-switcher-empty {
		padding: 8px;
	}

	.ws-create-workspace {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 6px;
	}

	.ws-create-workspace input {
		min-height: 40px;
		min-width: 0;
		border: 1px solid color-mix(in srgb, var(--color-ws-line, #a6b7dc) 12%, transparent);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.04);
		color: var(--color-ws-ink, #ececf2);
		padding: 0 9px;
		font-size: 12px;
		outline: none;
	}

	.ws-create-workspace input[aria-invalid="true"] {
		border-color: rgba(248, 113, 113, 0.6);
	}

	.ws-create-workspace-error {
		margin-top: 6px;
		padding: 7px 9px;
		border-radius: 8px;
		border: 1px solid rgba(248, 113, 113, 0.35);
		background: rgba(248, 113, 113, 0.1);
		color: #fca5a5;
		font-size: 11.5px;
		line-height: 1.4;
	}

	.ws-leave-dialog {
		display: grid;
		gap: 10px;
		padding: 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-rose, #FB7185) 32%, transparent);
		border-radius: 10px;
		background: rgba(32, 12, 18, 0.96);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
	}

	.ws-leave-dialog h2 {
		margin: 0;
		color: #ffe4e6;
		font-size: 13px;
		font-weight: 900;
		line-height: 1.25;
	}

	.ws-leave-dialog p {
		margin: 0;
		color: #fecdd3;
		font-size: 11px;
		line-height: 1.45;
	}

	.ws-leave-dialog .ws-leave-error {
		color: #fecdd3;
		font-weight: 800;
	}

	.ws-leave-actions {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}

	.ws-leave-actions button {
		min-height: 38px;
		border-radius: 8px;
		font-size: 11px;
		font-weight: 900;
	}

	.ws-leave-cancel {
		border: 1px solid var(--ws-hair-strong, rgba(255, 255, 255, 0.12));
		background: rgba(255, 255, 255, 0.06);
		color: var(--color-ws-text, #9a9aa8);
	}

	.ws-leave-confirm {
		border: 1px solid color-mix(in srgb, var(--color-ws-rose, #FB7185) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose, #FB7185) 20%, transparent);
		color: #ffe4e6;
	}

	.ws-create-workspace button,
	.ws-create-workspace span,
	.ws-settings-link {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid color-mix(in srgb, var(--color-ws-line, #a6b7dc) 12%, transparent);
		background: rgba(255, 255, 255, 0.04);
		color: var(--color-ws-ink, #ececf2);
		padding: 0 10px;
		font-size: 11px;
		font-weight: 900;
	}

	.ws-create-workspace span {
		color: var(--color-ws-faint, #6b6b78);
	}

	.ws-settings-link {
		width: 100%;
		color: var(--color-ws-accent, #8fb8ff);
	}

	:global(.workspace-sidebar-rail .nav-icon) {
		width: 17px;
		height: 17px;
		stroke-width: 1.7;
		color: inherit;
		transition: color 0.2s;
	}

	.sidebar-nav-btn.active :global(.nav-icon) {
		color: #c4b5fd;
		filter: none;
	}

	.sidebar-section-head {
		min-height: 36px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin: 2px 0 1px;
		padding: 0 4px 0 12px;
		color: var(--color-ws-faint, #6b6b78);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.13em;
		text-transform: uppercase;
	}

	.sidebar-section-head span {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sidebar-nav-disclosure {
		min-width: 0;
	}

	.sidebar-nav-disclosure > .font-sans {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sidebar-disclosure-icon {
		width: 14px;
		height: 14px;
		flex: 0 0 auto;
		color: var(--color-ws-faint, #6b6b78);
		stroke-width: 2;
		transition: color 0.16s ease, transform 0.16s ease;
	}

	.sidebar-disclosure-hit {
		min-width: 22px;
		min-height: 22px;
		display: grid;
		place-items: center;
		margin-left: auto;
		border-radius: 7px;
	}

	.sidebar-disclosure-hit:hover {
		background: rgba(255, 255, 255, 0.055);
	}

	.sidebar-nav-disclosure:hover .sidebar-disclosure-icon,
	.sidebar-nav-disclosure.active .sidebar-disclosure-icon {
		color: currentColor;
	}

	.sidebar-subnav-btn {
		position: relative;
		min-height: 40px;
		display: flex;
		width: calc(100% - 24px);
		align-items: center;
		gap: 10px;
		margin-left: 24px;
		padding: 7px 10px;
		border: 1px solid transparent;
		border-radius: 10px;
		background: transparent;
		color: var(--color-ws-text, #9a9aa8);
		font-size: 12px;
		font-weight: 500;
		text-align: left;
		transition: color 0.16s ease, background 0.16s ease, border-color 0.16s ease;
	}

	.sidebar-subnav-group {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 1px 0 5px;
	}

	.sidebar-subnav-label {
		margin: 7px 0 3px 24px;
		color: var(--color-ws-faint, #6b6b78);
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.sidebar-subnav-btn::before {
		content: "";
		position: absolute;
		left: -12px;
		top: 0;
		bottom: 0;
		width: 1px;
		background: var(--ws-hair, rgba(255, 255, 255, 0.07));
	}

	.sidebar-subnav-btn:hover {
		background: rgba(255, 255, 255, 0.04);
		color: var(--color-ws-ink, #ececf2);
	}

	.sidebar-subnav-btn.active {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 25%, transparent);
		background: linear-gradient(100deg, color-mix(in srgb, var(--color-ws-accent, #7c5cff) 18%, transparent), rgba(217, 70, 239, 0.07));
		color: var(--color-ws-ink, #ececf2);
	}

	.sidebar-subnav-btn.active :global(.nav-icon) {
		color: #c4b5fd;
	}

	.sidebar-subnav-btn :global(.nav-icon) {
		width: 14px;
		height: 14px;
		opacity: 0.82;
	}

	.sidebar-subnav-btn .subnav-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 1px;
		line-height: 1.1;
	}

	.sidebar-subnav-btn .subnav-copy > span,
	.sidebar-subnav-btn .subnav-copy > small {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sidebar-subnav-btn .subnav-copy > small {
		color: var(--color-ws-faint, #6b6b78);
		font-size: 9px;
		font-weight: 500;
	}

	.sidebar-subnav-btn.active .subnav-copy > small {
		color: rgba(196, 181, 253, 0.7);
	}

	.sidebar-subnav-btn.sidebar-subnav-empty {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 18%, transparent);
		background: rgba(255, 255, 255, 0.025);
		color: var(--color-ws-text, #9a9aa8);
	}

	/* Footer Settings control lights up when the standalone /settings shell is open,
	   so the sidebar shows the active surface the same way Storage does. */
	.ws-settings-footer-btn.active {
		color: var(--color-ws-ink, #ececf2);
	}

	.ws-settings-footer-btn.active :global(svg) {
		color: #c4b5fd;
		opacity: 1;
	}

	:global(.workspace-sidebar-rail .nav-icon-check) {
		width: 12px;
		height: 12px;
		stroke-width: 3.5;
		color: inherit;
	}

	/* anonymous sign-in / get-started CTAs */
	.ws-auth-cta {
		display: grid;
		gap: 6px;
	}

	.ws-auth-cta-primary,
	.ws-auth-cta-secondary {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 40px;
		border-radius: 9px;
		cursor: pointer;
		font-family: inherit;
		font-size: 12.5px;
		font-weight: 800;
		letter-spacing: 0.01em;
		transition: filter 0.14s ease, background 0.14s ease, border-color 0.14s ease;
	}

	.ws-auth-cta-primary {
		border: 0;
		background: linear-gradient(100deg, var(--color-ws-violet, #8B5CF6), #d946ef);
		color: #fff;
		box-shadow: 0 10px 26px -16px color-mix(in srgb, var(--color-ws-violet, #8B5CF6) 80%, transparent);
	}

	.ws-auth-cta-primary:hover {
		filter: brightness(1.08);
	}

	.ws-auth-cta-secondary {
		border: 1px solid color-mix(in srgb, var(--color-ws-blue, #8fb8ff) 18%, transparent);
		background: color-mix(in srgb, var(--color-ws-blue, #8fb8ff) 6%, transparent);
		color: var(--color-ws-ink, #ececf2);
	}

	.ws-auth-cta-secondary:hover {
		border-color: color-mix(in srgb, var(--color-ws-blue, #8fb8ff) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-blue, #8fb8ff) 10%, transparent);
	}

	/* user / plan button */
	.ws-user-btn {
		min-height: 0;
	}

	.ws-user-avatar {
		width: 32px;
		height: 32px;
		flex-shrink: 0;
		display: grid;
		place-items: center;
		border-radius: 999px;
		background: linear-gradient(135deg, var(--color-ws-accent, #7C5CFF), #d946ef);
		color: var(--color-ws-ink, #ececf2);
		font-size: 12px;
		font-weight: 600;
	}

	.ws-user-caret {
		width: 14px;
		height: 14px;
		flex-shrink: 0;
		color: var(--color-ws-faint, #6b6b78);
	}

	.ws-user-btn.active {
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 16%, transparent);
	}

	.ws-user-backdrop {
		position: fixed;
		inset: 0;
		z-index: 1390;
		min-width: 0;
		min-height: 0;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: default;
	}

	.ws-user-popover {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 0;
		right: 0;
		z-index: 1400;
		display: grid;
		gap: 8px;
		padding: 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-blue, #8fb8ff) 22%, transparent);
		border-radius: 10px;
		background: var(--color-ws-surface, #15151D);
		box-shadow: 0 18px 44px rgba(0, 0, 0, 0.46);
	}

	.ws-user-card {
		display: grid;
		gap: 3px;
		padding: 9px 10px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.08));
		border-radius: 8px;
		background: var(--color-ws-surface2, #1C1C26);
	}

	.ws-user-card-name {
		overflow: hidden;
		color: var(--color-ws-ink, #ececf2);
		font-size: 12px;
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ws-user-card-email {
		overflow: hidden;
		color: var(--color-ws-faint, #9aa0ad);
		font-size: 11px;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ws-user-card-role {
		color: #9bc7ff;
		font-size: 10px;
		font-weight: 800;
		text-transform: uppercase;
	}

	.ws-user-settings {
		min-height: 38px;
		border: 1px solid color-mix(in srgb, var(--color-ws-blue, #8fb8ff) 16%, transparent);
		border-radius: 7px;
		background: color-mix(in srgb, var(--color-ws-blue, #8fb8ff) 6%, transparent);
		color: var(--color-ws-ink, #ececf2);
		cursor: pointer;
		font-family: inherit;
		font-size: 12px;
		font-weight: 700;
	}

	.ws-user-settings:hover {
		border-color: color-mix(in srgb, var(--color-ws-blue, #8fb8ff) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-blue, #8fb8ff) 10%, transparent);
	}

	.ws-user-signout {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 38px;
		border: 1px solid rgba(255, 139, 124, 0.28);
		border-radius: 7px;
		background: rgba(255, 139, 124, 0.1);
		color: #ffd7d1;
		cursor: pointer;
		font-family: inherit;
		font-size: 12px;
		font-weight: 800;
	}

	.ws-user-signout:hover:not(.busy) {
		background: rgba(255, 139, 124, 0.18);
	}

	.ws-user-signout.busy {
		cursor: default;
		opacity: 0.7;
	}

	/* ── Switcher redesign (2026-06-13) ───────────────────────── */
	.ws-switcher-scrim {
		position: fixed;
		inset: 0;
		z-index: 59;
		background: rgba(5, 5, 10, 0.45);
		border: none;
		cursor: default;
	}
	.ws-popover-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.ws-popover-close {
		border: none;
		background: transparent;
		color: var(--color-ws-faint);
		font-size: 18px;
		line-height: 1;
		cursor: pointer;
		padding: 2px 6px;
		border-radius: var(--radius-ws-ctrl);
	}
	.ws-popover-close:hover { color: var(--color-ws-ink); background: var(--color-ws-surface2); }
	.ws-popover-section-label {
		font-size: 10.5px;
		font-weight: 800;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-ws-faint);
		padding: 8px 6px 2px;
	}
	.ws-option-check {
		width: 16px;
		height: 16px;
		color: var(--color-ws-accent);
		flex-shrink: 0;
	}
</style>
