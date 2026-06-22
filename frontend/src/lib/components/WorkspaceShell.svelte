<!-- WorkspaceShell - persistent editor/workspace chrome -->
<script lang="ts">
	import { onDestroy, onMount, untrack } from "svelte";
	import { _ } from "$lib/i18n";
	import { afterNavigate, beforeNavigate, goto } from "$app/navigation";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { canUseBackendProjectEndpoints, projectStore } from "$lib/stores/project.svelte.ts";
	import { aiJobsStore } from "$lib/stores/ai-jobs.svelte.ts";
	import Toolbar from "$lib/components/Toolbar.svelte";
	import ToolOptionsBar from "$lib/components/ToolOptionsBar.svelte";
	import CanvasArea from "$lib/components/CanvasArea.svelte";
	import StatusBar from "$lib/components/StatusBar.svelte";
	import EasyModePanel from "$lib/components/editor/EasyModePanel.svelte";
	import EditorLeftDock from "$lib/components/editor/EditorLeftDock.svelte";
	import RightPanel from "$lib/components/RightPanel.svelte";
	import PromptDialog from "$lib/components/PromptDialog.svelte";
	import ImportRemapDialog from "$lib/components/ImportRemapDialog.svelte";
	import PageRelinkConfirmationDialog from "$lib/components/PageRelinkConfirmationDialog.svelte";
	import AdminDialog from "$lib/components/AdminDialog.svelte";
	import ChapterSetupDialog from "$lib/components/ChapterSetupDialog.svelte";
	import NotificationPanel from "$lib/components/NotificationPanel.svelte";
	import Toast from "$lib/components/Toast.svelte";
	import { authStore } from "$lib/stores/auth.svelte.ts";
	import { notificationsStore } from "$lib/stores/notifications.svelte.ts";
	import BulkImportDialog from "$lib/components/BulkImportDialog.svelte";
	import {
		canSeedWorkspaceDebugProject,
		installWorkspaceDebug,
		loadWorkspaceDebugRoutePage,
		seedWorkspaceDebugProjectForRoute,
		uninstallWorkspaceDebug,
		workspaceDebugProjectIdForTitle,
	} from "$lib/debug/workspace-debug.ts";
	import WorkspaceDashboard from "$lib/components/WorkspaceDashboard.svelte";
	import WorkspaceInboxPageView from "$lib/components/WorkspaceInboxPageView.svelte";
	import WorkspaceTasksView from "$lib/components/WorkspaceTasksView.svelte";
	import WorkspaceLibraryView from "$lib/components/WorkspaceLibraryView.svelte";
	import WorkspacePagesView from "$lib/components/WorkspacePagesView.svelte";
	import WorkspaceWorkBoardV2 from "./WorkspaceWorkBoardV2.svelte";
	import WorkspaceImportReviewView from "$lib/components/WorkspaceImportReviewView.svelte";
	import WorkspaceMembersSettings from "$lib/components/WorkspaceMembersSettings.svelte";
	import WorkspaceReportsView from "$lib/components/WorkspaceReportsView.svelte";
	import ChapterReviewReader from "$lib/components/review/ChapterReviewReader.svelte";
	import EditorPathBar from "$lib/components/EditorPathBar.svelte";
	import WorkspaceSidebar from "$lib/components/WorkspaceSidebar.svelte";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { realtimeStore } from "$lib/stores/realtime.svelte.ts";
	import { locksStore } from "$lib/stores/locks.svelte.ts";
	import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
	import { workspaceHomeStore } from "$lib/stores/workspace-home.svelte.ts";
	import { queueWorkspaceNavigation } from "$lib/navigation/workspace-navigation.js";
	import { parseWorkspacePath } from "$lib/navigation/workspace-routes.js";
	import { buildWorkspaceProjectBrowser } from "$lib/project/workspace-dashboard.js";
	import { findStoryGroupByTitleKey } from "$lib/project/story-id.js";

	let { routeAware = false } = $props<{ routeAware?: boolean }>();
	let canvasEl = $state<HTMLCanvasElement>();
	let lastRouteKey = "";
	let routePageLoadKey = "";
	let routePageLoadInFlight = false;
	let showWorkspaceSaveRecovery = $derived(Boolean(projectStore.project && projectStore.saveSyncStatus === "error"));
	let saveRecoveryIsBrush = $derived(projectStore.saveErrorKind === "brush");
	// "Old work retained, new project NOT opened" — matched on the stable
	// `prev_work_present` code (was a startsWith on the rendered Thai status).
	let saveRecoveryIsBlockedProjectSwitch = $derived(
		projectStore.statusMsgCode === "prev_work_present"
	);
	let saveRecoveryTitle = $derived(projectStore.saveErrorKind === "conflict"
		? $_("workspaceShell.saveRecoveryConflictTitle")
		: saveRecoveryIsBrush
			? $_("workspaceShell.saveRecoveryBrushTitle")
		: saveRecoveryIsBlockedProjectSwitch
			? $_("workspaceShell.saveRecoveryBlockedSwitchTitle")
			: $_("workspaceShell.saveRecoveryFailedTitle"));
	let saveRecoveryDetail = $derived(saveRecoveryIsBrush
		? editorStore.brushTarget.kind === "image-layer"
			? $_("workspaceShell.saveRecoveryBrushLayerDetail")
			: $_("workspaceShell.saveRecoveryBrushCleanDetail")
		: projectStore.statusMsg || projectStore.saveErrorMessage || $_("workspaceShell.saveRecoveryFallbackDetail"));
	let saveRecoveryActionLabel = $derived(projectStore.saveErrorKind === "conflict"
		? $_("workspaceShell.saveRecoveryConflictAction")
		: saveRecoveryIsBrush
			? editorStore.brushTarget.kind === "image-layer" ? $_("workspaceShell.saveRecoveryBrushLayerAction") : $_("workspaceShell.saveRecoveryBrushCleanAction")
		: $_("workspaceShell.saveRecoveryRetryAction"));

	afterNavigate(({ to }) => {
		if (!routeAware) return;
		const target = parseWorkspacePath(to?.url.pathname ?? "/dashboard");
		const key = [
			target.surface,
			target.projectId ?? "",
			target.titleKey ?? "",
			target.language ?? "",
			target.pageIndex ?? "",
		].join(":");
		if (key === lastRouteKey) return;
		lastRouteKey = key;
		void syncRouteTarget(target);
	});

	// The shell (and the live editor) stay mounted across these top-level paths;
	// route groups like (workspace) are URL-transparent, so we match by pathname.
	// Leaving them (e.g. to /settings or /login) unmounts the shell → destroys the
	// editor, so a debounced instant edit must be flushed FIRST (#255 teardown).
	function isWorkspaceShellPath(pathname: string): boolean {
		return /^\/(dashboard|inbox|tasks|library|projects|reports)(\/|$)/.test(pathname) || pathname === "/";
	}

	// Flush a buffered instant edit BEFORE a client-side navigation tears the shell
	// down. beforeNavigate is synchronous and can't await, so when we're leaving the
	// shell with a pending edit we cancel, flush, then re-issue the navigation.
	let flushReentry = false;
	beforeNavigate((nav) => {
		if (flushReentry) return;
		const to = nav.to;
		if (!to) return;
		const toPath = to.url.pathname;
		if (isWorkspaceShellPath(toPath)) return; // within-shell nav is already drained by goToPage
		if (!editorStore.hasPendingEdits()) return;
		const href = `${to.url.pathname}${to.url.search}${to.url.hash}`;
		nav.cancel();
		void (async () => {
			await editorStore.flushPendingEdits();
			flushReentry = true;
			try {
				await goto(href);
			} finally {
				flushReentry = false;
			}
		})();
	});

	// Best-effort fallback for truly-synchronous unloads (tab close / hard reload /
	// full-page navigation) where neither beforeNavigate nor the awaited sign-out
	// hook can run. We can't await here, but firing the persist synchronously gives
	// the in-flight upload a chance to land instead of the edit being silently
	// dropped. visibilitychange=hidden is the more reliable trigger on mobile.
	function handleHardUnload(): void {
		if (!editorStore.hasPendingEdits()) return;
		void editorStore.flushPendingEdits();
	}
	function handleVisibilityHidden(): void {
		if (document.visibilityState === "hidden") handleHardUnload();
	}

	// The AI-jobs sign-out wipe is NOT registered here. It lives at the store level
	// (aiJobsStore.registerSignOutCleanup, called once from the root +layout) so it
	// survives this shell's unmount: routing to /settings unmounts the shell, and a
	// shell-scoped hook would be gone there, so signing out from /settings would skip
	// the queue wipe and leak the previous user's jobs into the next session. The
	// shell only owns the transient suspend/resume of poll intervals (onDestroy /
	// onMount), never the session-scoped cleanup.

	onMount(async () => {
		if (typeof window !== "undefined") {
			window.addEventListener("beforeunload", handleHardUnload);
			document.addEventListener("visibilitychange", handleVisibilityHidden);
		}
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
		if (canvasEl) {
			await editorStore.init(canvasEl);
			installWorkspaceDebug();
			// Re-arm AI polling for any job left running when the shell was last torn down
			// by a route-away (suspendPolling). The editor is freshly built, so the re-armed
			// polls can safely touch the canvas again; only the currently-open project's
			// processing rows are resumed (others stay dormant). No-op on a first mount
			// (nothing suspended) or after a sign-out wipe (queue empty, flag cleared).
			aiJobsStore.resumePolling(editorStore.editor);
			if (editorUiStore.workspaceView === "editor" && projectStore.project?.pages.length && !editorStore.hasImage) {
				await loadWorkspaceRoutePage(projectStore.project.currentPage);
			}
		}
	});

	onDestroy(() => {
		if (typeof window !== "undefined") {
			window.removeEventListener("beforeunload", handleHardUnload);
			document.removeEventListener("visibilitychange", handleVisibilityHidden);
		}
		uninstallWorkspaceDebug();
		notificationsStore.stopPolling();
		realtimeStore.disconnect();
		// Stop every per-job AI poll INTERVAL — without this a job that resolves after the
		// shell unmounts keeps hitting the protected status endpoint and, through its
		// captured `editor` closure, throws inside the disposed Fabric canvas — the
		// zombie-polling leak. But onDestroy ALSO fires on a mere route-away WITHIN the
		// session (e.g. to /settings), so we must NOT take the full sign-out teardown here:
		// that would bump the generation and make an in-flight submit for the STILL-owned
		// project skip its server marker (an accepted+charged job with no marker to reload).
		// suspendPolling clears the timers only; the queue + generation survive, in-flight
		// submits still write their server marker, and the next mount calls resumePolling.
		// The actual sign-out wipe goes through cleanup(), wired at the STORE level
		// (aiJobsStore.registerSignOutCleanup, from the root +layout) so it survives this
		// unmount and fires even when sign-out happens from a non-shell route like /settings.
		aiJobsStore.suspendPolling();
		// onMount calls editorStore.init() which builds the MangaEditor (a Fabric
		// canvas plus document keydown/copy/space listeners). Tear it down here so
		// the canvas, its contexts, and the global listeners do not leak when the
		// shell unmounts. onDestroy is synchronous and can't await, so any buffered
		// instant edit is flushed by the AWAITED teardown initiators FIRST: the
		// sign-out hook (auth.registerPreSignOut) and the beforeNavigate guard above.
		editorStore.destroy();
	});

	// Wave 2 W2.5 — keep the notifications cache + unread count in sync with the
	// auth lifecycle. Polling stops as soon as the user signs out so we do not
	// keep firing /api/notifications against a 401.
	$effect(() => {
		const userId = authStore.user?.id;
		if (authStore.isAuthenticated && userId) {
			notificationsStore.startPolling(userId);
		} else {
			notificationsStore.stopPolling();
			notificationsStore.reset();
		}
	});

	// W2.7 Realtime: open the SSE stream whenever an authenticated session is
	// available, scoped to a REAL workspace the server knows about. The backend
	// emits comment_new / activity_feed / ai_job_status / lock_* events to the
	// project's workspaceId, so the client must subscribe to that same id — but it
	// must be a workspace the user is actually a member of. We resolve, in order:
	// the active project's workspaceId, then the user's current workspace. We do
	// NOT fall back to a magic "default" channel: the backend rejects unknown
	// workspaces with 404 (workspace_not_found), and a reactive re-subscribe to a
	// rejected channel previously spun a token-mint storm (>500 req/s). When no
	// real workspace is resolvable yet (e.g. workspaces still loading on the
	// pre-project dashboard) we simply don't open a stream until one is.
	$effect(() => {
		locksStore.wireToRealtime();
		const accessToken = authStore.accessToken;
		if (!accessToken) {
			realtimeStore.disconnect("auth_change");
			return;
		}
		const targetWorkspaceId = projectStore.project?.workspaceId?.trim()
			|| workspacesStore.currentWorkspace?.workspaceId?.trim()
			|| null;
		if (!targetWorkspaceId) {
			return;
		}
		// Already attached (or attaching/retrying/terminally-unavailable) for this
		// workspace — leave the store's own connect/reconnect loop to own it. connect()
		// is also idempotent for the same id, but short-circuiting here avoids churn.
		if (realtimeStore.workspaceId === targetWorkspaceId
			&& realtimeStore.status !== "idle" && realtimeStore.status !== "closed") {
			return;
		}
		void realtimeStore.connect(targetWorkspaceId);
	});

	// Recover the realtime stream from a TERMINAL "unavailable" (a 401/403/404/501
	// token mint that stopped reconnects to kill the self-DoS storm) when the
	// workspace list reloads — e.g. the user was just granted membership, or a
	// transient backend error has cleared. loadEpoch bumps only on a successful
	// fetch, so this is a discrete trigger that cannot reintroduce the mint loop;
	// revalidate() is a no-op unless we are actually "unavailable", after which the
	// effect above re-runs and reconnects once.
	$effect(() => {
		// Depend ONLY on loadEpoch (a discrete, fetch-gated counter). revalidate()
		// reads realtimeStore.status internally; without untrack() this $effect would
		// also track that status and re-run on every status flip, so a persistent 404
		// (unavailable) would loop unavailable→idle→connect→404 and re-enter the very
		// token-mint storm this guards against. untrack() keeps the trigger discrete.
		void workspacesStore.loadEpoch;
		untrack(() => realtimeStore.revalidate());
	});

	// Load the cross-project workspace-home aggregate whenever the active workspace
	// (or session) changes. This is the KEYSTONE that decouples the dashboard /
	// My-Work / activity / pipeline widgets from the open chapter: the aggregate is
	// keyed ONLY off the workspace id, never projectStore.project, so opening a
	// chapter changes the inspector but not the home's data. loadEpoch is included
	// so a freshly-granted membership re-fetches once (it bumps only on a successful
	// workspace-list fetch, so this cannot loop).
	$effect(() => {
		const accessToken = authStore.accessToken;
		void workspacesStore.loadEpoch;
		const workspaceId = workspacesStore.currentWorkspace?.workspaceId?.trim() || null;
		if (!accessToken) {
			untrack(() => workspaceHomeStore.reset());
			return;
		}
		if (!workspaceId) {
			untrack(() => workspaceHomeStore.reset());
			return;
		}
		untrack(() => void workspaceHomeStore.load(workspaceId));
	});

	$effect(() => {
		if (!routeAware || editorUiStore.workspaceView !== "editor") return;
		const project = projectStore.project;
		const editor = editorStore.editor;
		const pageIndex = project?.currentPage ?? -1;
		const page = project?.pages[pageIndex];
		if (!project || !editor || !page || editorStore.hasImage) return;

		const key = `${project.projectId}:${pageIndex}:${page.imageId}`;
		if (routePageLoadInFlight || routePageLoadKey === key) return;

		routePageLoadKey = key;
		routePageLoadInFlight = true;
		void loadWorkspaceRoutePage(pageIndex).finally(() => {
			routePageLoadInFlight = false;
		});
	});

	function captureWorkspaceRouteState() {
		return {
			view: editorUiStore.workspaceView,
			titleKey: editorUiStore.workspaceTitleKey,
			languageKey: editorUiStore.workspaceLanguageKey,
			projectId: projectStore.project?.projectId ?? null,
			pageIndex: projectStore.project?.currentPage ?? 0,
		};
	}

	function restoreBlockedProjectRoute(previous: ReturnType<typeof captureWorkspaceRouteState>): void {
		editorUiStore.setWorkspaceView(previous.view);
		editorUiStore.setWorkspaceTitleKey(previous.titleKey);
		editorUiStore.setWorkspaceLanguageKey(previous.languageKey);
		if (previous.view === "library") {
			if (previous.titleKey && previous.languageKey) {
				queueWorkspaceNavigation({
					view: "language",
					titleKey: previous.titleKey,
					language: previous.languageKey,
				});
				return;
			}
			if (previous.titleKey) {
				queueWorkspaceNavigation({ view: "title", titleKey: previous.titleKey });
				return;
			}
			queueWorkspaceNavigation({ view: "library" });
			return;
		}
		if (previous.view === "dashboard" || !previous.projectId) {
			queueWorkspaceNavigation({ view: previous.view });
			return;
		}
		queueWorkspaceNavigation({
			view: previous.view,
			projectId: previous.projectId,
			pageIndex: previous.view === "editor" ? previous.pageIndex : undefined,
		});
	}

	async function syncRouteTarget(target: ReturnType<typeof parseWorkspacePath>): Promise<void> {
		const previousRouteState = captureWorkspaceRouteState();
		editorUiStore.setWorkspaceView(target.workspaceView);
		// Keep the selected story/chapter pinned across navigation (e.g. back to the
		// overview) until the user picks a different one. The sidebar derives the ACTIVE
		// highlight from the route, so a persisted title key does not wrongly light up.
		if (target.titleKey !== undefined) {
			editorUiStore.setWorkspaceTitleKey(target.titleKey);
		}
		if (target.language !== undefined) {
			editorUiStore.setWorkspaceLanguageKey(target.language);
		} else if (target.surface === "title") {
			editorUiStore.setWorkspaceLanguageKey(null);
		}
		if (!target.projectId && (target.surface === "title" || target.surface === "language")) {
			const debugProjectId = workspaceDebugProjectIdForTitle(target.titleKey);
			if (debugProjectId && projectStore.project?.projectId !== debugProjectId) {
				await seedWorkspaceDebugProjectForRoute(debugProjectId);
			}
		}
		if (target.projectId && projectStore.project?.projectId !== target.projectId) {
			const seededDebugProject = await seedWorkspaceDebugProjectForRoute(target.projectId, {
				pageIndex: target.pageIndex,
			});
			if (!seededDebugProject && target.surface === "chapter" && !canUseBackendProjectEndpoints(target.projectId)) {
				// Stable `summary_only_loaded` code so WorkspaceLibraryView can gate the
				// chapter on the code, not a `statusMsg === "<Thai>"` string compare.
				projectStore.setStatusMsg($_("workspaceShell.statusSummaryOnlyLoaded"), "summary_only_loaded");
			} else if (!seededDebugProject && target.workspaceView === "editor" && target.pageIndex !== undefined) {
				const opened = await projectStore.openProject(target.projectId, editorStore.editor, {
					initialPageIndex: target.pageIndex,
				});
				if (opened === false) {
					restoreBlockedProjectRoute(previousRouteState);
					return;
				}
			} else if (!seededDebugProject) {
				const opened = await projectStore.openProject(target.projectId, editorStore.editor);
				if (opened === false) {
					restoreBlockedProjectRoute(previousRouteState);
					return;
				}
			} else if (target.workspaceView === "editor" && editorStore.editor) {
				await loadWorkspaceRoutePage(target.pageIndex ?? projectStore.project?.currentPage ?? 0);
			}
		}
		if (target.surface === "language") {
			const opened = await openLanguageRouteChapter(target.titleKey, target.language);
			if (opened === false) {
				restoreBlockedProjectRoute(previousRouteState);
				return;
			}
		}
		if (target.surface === "chapter" && projectStore.project?.targetLang) {
			editorUiStore.setWorkspaceLanguageKey(projectStore.project.targetLang);
		}
		if (target.workspaceView === "editor" && projectStore.project && projectStore.project.pages.length === 0) {
			projectStore.setStatusMsg($_("workspaceShell.statusZeroPage"));
			editorUiStore.openLibrary();
			editorUiStore.openChapterSetup({
				mode: "fill-existing-zero-page",
				projectId: projectStore.project.projectId,
				titleKey: editorUiStore.workspaceTitleKey,
			});
			queueWorkspaceNavigation({ view: "library" });
			return;
		}
		if (target.pageIndex !== undefined && projectStore.project) {
			const pageAlreadyOpen = projectStore.project.currentPage === target.pageIndex;
			const pageOpened = pageAlreadyOpen
				? true
				: await projectStore.goToPage(target.pageIndex, editorStore.editor);
			if (!pageOpened) {
				queueWorkspaceNavigation({
					view: "editor",
					projectId: projectStore.project.projectId,
					pageIndex: projectStore.project.currentPage,
				});
				return;
			}
		}
		if (target.workspaceView === "editor" && editorStore.editor && projectStore.project?.pages.length && !editorStore.hasImage) {
			await loadWorkspaceRoutePage(projectStore.project.currentPage);
		}
	}

	async function loadWorkspaceRoutePage(pageIndex: number): Promise<void> {
		if (projectStore.project && canSeedWorkspaceDebugProject(projectStore.project.projectId)) {
			const loadedDebugPage = await loadWorkspaceDebugRoutePage(pageIndex);
			if (loadedDebugPage) return;
		}
		await projectStore.loadPage(pageIndex, editorStore.editor);
	}

	async function openLanguageRouteChapter(titleKey?: string, language?: string): Promise<boolean> {
		if (!titleKey || !language) return true;
		if (!projectStore.recentProjects.length) {
			await projectStore.loadRecentProjects();
		}
		const title = findStoryGroupByTitleKey(
			buildWorkspaceProjectBrowser(projectStore.recentProjects, 24, 100),
			(group) => group.storyId,
			titleKey,
		);
		const chapter = title?.chapters.find((item) => item.project.targetLang === language);
		if (!chapter) return true;
		if (projectStore.project?.projectId !== chapter.project.projectId) {
			const opened = await projectStore.openProject(chapter.project.projectId, editorStore.editor);
			if (opened === false) return false;
			editorStore.refreshTextLayers();
		} else if (!projectStore.tasks.length && !projectStore.workflowLoading) {
			await projectStore.loadWorkflow();
			editorStore.refreshTextLayers();
		}
		editorUiStore.setWorkspaceLanguageKey(chapter.project.targetLang);
		return true;
	}

	function recoverWorkspaceSaveFailure(): void {
		if (projectStore.saveErrorKind === "conflict") {
			window.dispatchEvent(new CustomEvent("manga-editor:request-conflict-reload"));
			return;
		}
		if (projectStore.saveErrorKind === "brush") {
			returnToCurrentEditor();
			editorStore.setTool("brush");
			editorUiStore.setRightPanelMode(editorStore.brushTarget.kind === "image-layer" ? "layers" : "ai");
			return;
		}
		void projectStore.saveCurrentPage(editorStore.editor);
	}

	function returnToCurrentEditor(): void {
		const project = projectStore.project;
		if (!project || !project.pages.length) return;
		editorUiStore.openEditor();
		queueWorkspaceNavigation({
			view: "editor",
			projectId: project.projectId,
			pageIndex: project.currentPage,
		});
	}
</script>

	<div class="workspace-app-shell ws-sans">
		<WorkspaceSidebar />

		{#if editorUiStore.workspaceNavOpen}
			<button
				type="button"
				class="workspace-nav-backdrop"
				aria-label={$_("workspaceShell.navBackdropClose")}
				onclick={() => editorUiStore.closeWorkspaceNav()}
			></button>
		{/if}

		<div
		class="editor-root"
		class:workspace-dashboard-view={editorUiStore.workspaceView === "dashboard" || editorUiStore.workspaceView === "inbox" || editorUiStore.workspaceView === "tasks" || editorUiStore.workspaceView === "settings" || editorUiStore.workspaceView === "reports"}
		class:workspace-library-view={editorUiStore.workspaceView === "library"}
		class:workspace-pages-view={editorUiStore.workspaceView === "pages"}
		class:workspace-work-view={editorUiStore.workspaceView === "work"}
		class:workspace-review-view={editorUiStore.workspaceView === "review"}
		class:workspace-import-view={editorUiStore.workspaceView === "import"}
		class:workspace-editor-view={editorUiStore.workspaceView === "editor"}
		class:inspector-hidden={editorUiStore.workspaceView === "editor" && !editorUiStore.inspectorOpen}
	>
		<div class="toolbar-area">
			<Toolbar />
			{#if editorUiStore.workspaceView === "editor"}
				<ToolOptionsBar />
			{/if}
		</div>

		<div class="tools-area">
			{#if editorUiStore.workspaceView === "editor"}
				<div class="tools-stack">
					<EasyModePanel />
					<EditorLeftDock />
				</div>
			{/if}
		</div>

		<main class="canvas-area" aria-label={$_("workspaceShell.mainWorkArea")}>
			<CanvasArea bind:canvasRef={canvasEl} />
			{#if editorUiStore.workspaceView === "editor"}
				<EditorPathBar />
			{/if}
			{#if showWorkspaceSaveRecovery && projectStore.project}
				<section class="workspace-save-recovery ws-panel rounded-ws-card" aria-label={$_("workspaceShell.saveRecoveryRegion")}>
					<div>
						<span>{$_("workspaceShell.saveRecoverySafe")}</span>
						<strong>{saveRecoveryTitle}</strong>
						<small>{saveRecoveryDetail}</small>
					</div>
					<div class="workspace-save-recovery-actions">
						<button type="button" class="primary ws-grad-primary rounded-ws-ctrl" onclick={recoverWorkspaceSaveFailure}>
							{saveRecoveryActionLabel}
						</button>
						{#if projectStore.project.pages.length}
							<button type="button" class="ws-btn-ghost rounded-ws-ctrl" onclick={returnToCurrentEditor}>{$_("workspaceShell.returnToCurrentWork")}</button>
						{/if}
					</div>
				</section>
			{/if}
			<WorkspaceDashboard />
			<WorkspaceInboxPageView />
			<WorkspaceTasksView />
			<WorkspaceLibraryView />
			<WorkspacePagesView />
			<WorkspaceWorkBoardV2 />
			<WorkspaceImportReviewView />
			<WorkspaceMembersSettings />
			<WorkspaceReportsView />
			<ChapterReviewReader />
		</main>

		<div class="panel-area">
			<RightPanel />
		</div>

		<div class="status-area">
			<StatusBar />
		</div>
	</div>
</div>

<PromptDialog />
<ImportRemapDialog />
<PageRelinkConfirmationDialog />
<AdminDialog />
<ChapterSetupDialog />
<NotificationPanel
	open={editorUiStore.notificationPanelOpen}
	onClose={() => editorUiStore.closeNotificationPanel()}
/>
<Toast />
<BulkImportDialog />

<style>
	.workspace-app-shell {
		display: flex;
		width: 100vw;
		height: 100vh;
		overflow: hidden;
		background:
			radial-gradient(circle at 5% 5%, color-mix(in srgb, var(--color-ws-green) 12%, transparent), transparent 45%),
			radial-gradient(circle at 95% 5%, color-mix(in srgb, var(--color-ws-accent) 12%, transparent), transparent 45%),
			var(--color-ws-bg);
	}

	.workspace-app-shell :global(.editor-root) {
		flex: 1;
		min-width: 0;
		height: 100%;
	}

	.tools-stack {
		display: flex;
		width: 100%;
		height: 100%;
		min-height: 0;
		flex-direction: column;
		background: var(--editor-surface);
	}

	.tools-stack :global(.editor-left-dock) {
		flex: 1 1 auto;
		min-height: 0;
	}

	.workspace-nav-backdrop {
		display: none;
		border: 0;
		padding: 0;
	}

	@media (max-width: 1024px) {
		.workspace-nav-backdrop {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 1150;
			background: color-mix(in srgb, var(--color-ws-bg) 72%, transparent);
			cursor: pointer;
		}
	}

	.workspace-save-recovery {
		position: absolute;
		inset: auto auto 14px 18px;
		z-index: 90;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 14px;
		align-items: center;
		width: min(760px, calc(100% - 36px));
		padding: 14px 16px;
		border-color: color-mix(in srgb, var(--color-ws-amber) 44%, var(--ws-hair));
		background: linear-gradient(135deg,
			color-mix(in srgb, var(--color-ws-amber) 12%, var(--color-ws-surface) 88%),
			var(--color-ws-surface));
		color: var(--color-ws-ink);
	}

	.workspace-save-recovery span,
	.workspace-save-recovery small {
		display: block;
		color: var(--color-ws-text);
	}

	.workspace-save-recovery span {
		margin-bottom: 4px;
		color: var(--color-ws-amber);
		font-size: 11px;
		font-weight: 900;
		text-transform: uppercase;
	}

	.workspace-save-recovery strong {
		display: block;
		font-size: 16px;
		line-height: 1.25;
	}

	.workspace-save-recovery small {
		margin-top: 4px;
		font-size: 12px;
		line-height: 1.35;
	}

	.workspace-save-recovery-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
	}

	.workspace-save-recovery button {
		min-height: 40px;
		border: 1px solid var(--ws-hair-strong);
		padding: 0 14px;
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 900;
	}

	.workspace-save-recovery button.primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 52%, var(--ws-hair-strong));
		color: var(--color-ws-ink);
	}

	@media (max-width: 720px) {
		.workspace-save-recovery {
			inset: 10px 10px auto 10px;
			width: auto;
			grid-template-columns: 1fr;
		}

		.workspace-save-recovery-actions {
			justify-content: stretch;
		}

		.workspace-save-recovery button {
			flex: 1 1 140px;
		}
	}
</style>
