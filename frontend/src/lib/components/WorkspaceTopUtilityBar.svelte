<script lang="ts">
	import { page } from "$app/state";
	import { _, chapterLabelPrefix } from "$lib/i18n";
	import { queueWorkspaceNavigation } from "$lib/navigation/workspace-navigation.js";
	import {
		parseWorkspacePath,
		type WorkspaceHrefInput,
		type WorkspaceRouteTarget,
	} from "$lib/navigation/workspace-routes.js";
	import {
		getWorkspaceHelpTopicIdForView,
		resolveWorkspaceHelpTopic,
		type WorkspaceHelpTopicId,
	} from "$lib/help/workspace-help.js";
	import { buildWorkspaceProjectBrowser } from "$lib/project/workspace-dashboard.js";
	import { titleFallback, resolveStoryTitle, resolveChapterLabel } from "$lib/navigation/workspace-labels.js";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";
	import { permissions } from "$lib/stores/permissions.svelte.ts";
	import { notificationsStore } from "$lib/stores/notifications.svelte.ts";
	import { billingStore } from "$lib/stores/billing.svelte.ts";
	import { usageStore, thbToCredits, formatCreditsCompact } from "$lib/stores/usage.svelte.ts";
	import PlanBadge from "$lib/components/ui/PlanBadge.svelte";
	import { realtimeStore } from "$lib/stores/realtime.svelte.ts";
	import { workspaceHomeStore } from "$lib/stores/workspace-home.svelte.ts";
	import WorkspaceBreadcrumb from "./WorkspaceBreadcrumb.svelte";
	import AuthAccountMenu from "./AuthAccountMenu.svelte";
	import type { Snippet } from "svelte";

	interface BreadcrumbItem {
		label: string;
		target?: WorkspaceHrefInput;
		current?: boolean;
	}

	// Localise via svelte-i18n with an explicit fallback ($_ returns the key
	// itself on a miss / before init, so guard against that).
	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	let {
		value = $bindable(""),
		placeholder,
		ariaLabel,
		profileTitle = "Comic Workspace",
		profileMeta,
		onKeydown,
		onClear,
		searchPanel,
	}: {
		value?: string;
		placeholder?: string;
		ariaLabel?: string;
		profileTitle?: string;
		profileMeta?: string;
		onKeydown?: (event: KeyboardEvent) => void;
		onClear?: () => void;
		searchPanel?: Snippet;
	} = $props();

	// Localised defaults — only used when the parent does not supply a value.
	let searchPlaceholder = $derived(placeholder ?? t("topbar.searchPlaceholder", "Search stories, chapters, or files…"));
	let searchAriaLabel = $derived(ariaLabel ?? t("topbar.searchAria", "Search stories, chapters, or files"));
	let openHelpTopicId = $state<WorkspaceHelpTopicId | null>(null);
	let helpButton: HTMLButtonElement | null = $state(null);
	let helpPopover: HTMLDivElement | null = $state(null);

	// First-run scope gate for the primary Create button — mirrors the dashboard CTA
	// (`WorkspaceDashboard.createFirstChapter`). The Create button opens a brand-new
	// ("create" mode) chapter, which MUST be workspace-scoped; if no workspace has
	// resolved yet we block the open (and nudge a reload) instead of letting the dialog
	// mint an unscoped/orphan project. The store guard (requireScopedCreate) is the
	// hard backstop; this gate makes the two entry points behave identically.
	let workspaceReady = $derived(Boolean(workspacesStore.currentWorkspace?.workspaceId));

	function handleCreate(): void {
		if (!workspaceReady) {
			projectStore.setStatusMsg(t("topbar.workspaceResolving", "กำลังตั้งค่าเวิร์กสเปซ… ลองอีกครั้งสักครู่"));
			// Retry resolving the workspace so the user can simply click again once ready.
			void workspacesStore.load().catch(() => undefined);
			return;
		}
		editorUiStore.openChapterSetup();
	}

	let currentRoute = $derived(parseWorkspacePath(page.url.pathname));
	let projectBrowserGroups = $derived(buildWorkspaceProjectBrowser(projectStore.recentProjects, 24, 100, $chapterLabelPrefix));
	let breadcrumbItems = $derived(buildBreadcrumbItems(currentRoute));
	let currentHelpTopicId = $derived(getWorkspaceHelpTopicIdForView(editorUiStore.workspaceView));
	let currentHelpTopic = $derived(currentHelpTopicId ? resolveWorkspaceHelpTopic(currentHelpTopicId, (key) => t(key, key)) : null);
	let helpOpen = $derived(Boolean(currentHelpTopicId && openHelpTopicId === currentHelpTopicId));
	let helpPopoverId = $derived(currentHelpTopicId ? `workspace-help-popover-${currentHelpTopicId}` : undefined);
	let helpTitleId = $derived(currentHelpTopicId ? `workspace-help-title-${currentHelpTopicId}` : undefined);
	let helpDescriptionId = $derived(currentHelpTopicId ? `workspace-help-description-${currentHelpTopicId}` : undefined);

	// Real unread count from the notifications store. The topbar bell and the
	// inbox icon share this number — we used to render a hardcoded "5". When
	// the count exceeds 99 we cap the display with "99+" to keep the badge a
	// fixed width.
	let unreadCount = $derived(notificationsStore.unreadCount);
	let unreadBadge = $derived(unreadCount > 99 ? "99+" : String(unreadCount));
	let hasUnread = $derived(unreadCount > 0);

	// --- AI credits meter (W2.2) ----------------------------------------------
	// Pull live AI usage from the workspace usage store (sidebar starts the
	// polling lifecycle). Until the dashboard loads we render an HONEST zero /
	// loading state — never fabricated numbers. A real account must never see
	// invented usage figures in the always-mounted top bar.
	let aiWindow = $derived(usageStore.ai);
	let hasLiveAi = $derived(Boolean(usageStore.dashboard));
	let aiCommittedThb = $derived(aiWindow?.aiCommittedThb ?? 0);
	let aiReservedThb = $derived(aiWindow?.aiActiveReservedThb ?? 0);
	let aiTotalCommitted = $derived(aiCommittedThb + aiReservedThb);
	let aiLimitThb = $derived(aiWindow?.limits.aiCreditThb ?? 0);
	let aiPctValue = $derived(hasLiveAi ? Math.min(100, usageStore.aiPct) : 0);
	// User-facing balance/limit are CREDITS, not baht. The usage windows are
	// THB-denominated, so convert with the canonical plan rate (display-only).
	let aiUsedLabel = $derived(hasLiveAi ? formatCreditsCompact(thbToCredits(aiTotalCommitted)) : "0");
	let aiLimitLabel = $derived(hasLiveAi && aiLimitThb > 0 ? formatCreditsCompact(thbToCredits(aiLimitThb)) : "—");
	// Remaining-countdown (issue #3): the chip leads with credits LEFT; the bar
	// depletes. `null` remaining ⇒ unlimited.
	// Gate on hasLiveAi: before the dashboard polls, aiLimitThb is 0 and the store
	// returns 0 (not null) for remaining — without this guard the chip would flash
	// a fabricated "ไม่จำกัด"/Unlimited on every load. Not-live ⇒ honest "0 / —".
	let aiUnlimited = $derived(hasLiveAi && (usageStore.aiRemainingThb === null || aiLimitThb <= 0));
	let aiRemainingLabel = $derived(aiUnlimited ? "" : hasLiveAi ? formatCreditsCompact(usageStore.aiRemainingCredits ?? 0) : "0");
	let aiRemainingPctValue = $derived(hasLiveAi ? Math.max(0, 100 - aiPctValue) : 0);
	let aiTitle = $derived(
		hasLiveAi
			? (aiUnlimited
				? `AI credits · ${t("topbar.unlimited", "ไม่จำกัด")}`
				: `AI credits · ${t("topbar.remaining", "เหลือ")} ${aiRemainingLabel} / ${aiLimitLabel} · ${t("topbar.used", "ใช้ไป")} ${aiUsedLabel}`)
			: `AI credits · ${t("topbar.loading", "Loading")}`,
	);
	// The bar shows REMAINING (depletes as credits are consumed); when unlimited
	// it stays full. Warning gradients still key off the near/at-limit bands.
	let aiBarPct = $derived(aiUnlimited ? 100 : aiRemainingPctValue);
	let aiFillStyle = $derived(
		usageStore.isAiAtLimit
			? `width: ${aiBarPct}%; background: linear-gradient(90deg,var(--color-ws-rose),var(--color-ws-violet))`
			: usageStore.isAiNearLimit
				? `width: ${aiBarPct}%; background: linear-gradient(90deg,var(--color-ws-amber),var(--color-ws-rose))`
				: `width: ${aiBarPct}%; background: linear-gradient(90deg,var(--color-ws-violet),var(--color-ws-accent))`,
	);
	// Plan badge — sourced from the SAME resolved plan that drives the AI-credit
	// allowance shown right beside it (usageStore.resolvedPlanKey), so the badge
	// can never say "free" next to a Studio 700-credit cap. Falls back to the
	// billing-assignment plan until the usage dashboard loads.
	let planKey = $derived(usageStore.resolvedPlanKey ?? billingStore.publicPlanKey ?? "free");
	let hasPlanContext = $derived(usageStore.hasResolvedPlan || Boolean(billingStore.subscription));

	// ── Realtime live-connection pulse (W2.7) ─────────────────────────────
	// The notifications inbox (W2.5) now owns the unread count + bell badge.
	// Realtime SSE adds a "live" pulse on the activity icon so users can see
	// the workspace stream is actually connected (vs. a stale dashboard from a
	// crashed tab), plus a lightweight in-session preview of the latest
	// streamed activity/comment event.
	let recentActivityPreview = $state<string>("");

	// A peer renamed a story/project (project_meta_changed) — re-fetch the catalog
	// (Library shelves, sidebar chapter list) + the workspace-home aggregate (dashboard)
	// so the FRESH title shows for this member within seconds. writeProjectState on the
	// server already busted its caches; this closes the PUSH half so nobody stares at a
	// stale title for the whole session. Debounced so a burst of renames coalesces.
	let catalogRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	function scheduleCatalogRefresh(): void {
		clearTimeout(catalogRefreshTimer);
		catalogRefreshTimer = setTimeout(() => {
			const wsId = workspacesStore.currentWorkspace?.workspaceId ?? null;
			void projectStore.loadRecentProjects({ background: true, preserveExistingOrder: true, workspaceId: wsId ?? undefined });
			void workspaceHomeStore.load(wsId);
		}, 400);
	}

	$effect(() => {
		const off = realtimeStore.onAny((event) => {
			if (event.kind === "activity_feed" || event.kind === "comment_new") {
				const data = event.data as { actor?: string; verb?: string; excerpt?: string; author?: string };
				const who = (data.actor || data.author || t("topbar.team", "Team")).toString();
				if (event.kind === "comment_new") {
					recentActivityPreview = `${who} ${t("topbar.replied", "replied")}${data.excerpt ? ` · ${String(data.excerpt).slice(0, 40)}` : ""}`;
				} else {
					recentActivityPreview = `${who} ${(data.verb || t("topbar.updated", "updated"))}`;
				}
			} else if (event.kind === "project_meta_changed") {
				scheduleCatalogRefresh();
			}
		});
		return () => {
			off();
			clearTimeout(catalogRefreshTimer);
		};
	});

	let liveTitle = $derived(realtimeStore.connected ? t("topbar.liveOn", "Live connected") : t("topbar.liveOff", "Offline / connecting"));

	function clearSearch(): void {
		value = "";
		onClear?.();
	}

	function togglePageHelp(): void {
		if (!currentHelpTopicId) return;
		openHelpTopicId = helpOpen ? null : currentHelpTopicId;
	}

	function closePageHelp(options: { restoreFocus?: boolean } = {}): void {
		if (!helpOpen) return;
		openHelpTopicId = null;
		if (options.restoreFocus) helpButton?.focus();
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (!helpOpen || event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		closePageHelp({ restoreFocus: true });
	}

	function handleWindowClick(event: MouseEvent): void {
		if (!helpOpen) return;
		const target = event.target;
		if (!(target instanceof Node)) return;
		if (helpPopover?.contains(target) || helpButton?.contains(target)) return;
		closePageHelp();
	}

	function openBreadcrumbTarget(target: WorkspaceHrefInput): void {
		queueWorkspaceNavigation(target);
	}

	function buildBreadcrumbItems(route: WorkspaceRouteTarget): BreadcrumbItem[] {
		const dashboardLabel = t("topbar.breadcrumbDashboard", "Dashboard");
		const inboxLabel = t("topbar.breadcrumbInbox", "Inbox");
		const tasksLabel = t("topbar.breadcrumbTasks", "My tasks");
		const libraryLabel = t("topbar.breadcrumbLibrary", "Library");
		if (route.surface === "dashboard") return [{ label: dashboardLabel, current: true }];
		if (route.surface === "inbox") {
			return [
				{ label: dashboardLabel, target: { view: "dashboard" } },
				{ label: inboxLabel, current: true },
			];
		}
		if (route.surface === "tasks") {
			return [
				{ label: dashboardLabel, target: { view: "dashboard" } },
				{ label: tasksLabel, current: true },
			];
		}
		if (route.surface === "library") {
			return [
				{ label: dashboardLabel, target: { view: "dashboard" } },
				{ label: libraryLabel, current: true },
			];
		}

		const storyKey = route.titleKey ?? projectStore.project?.storyId ?? undefined;
		const storyLabel = resolveStoryTitle(projectBrowserGroups, storyKey) || projectStore.project?.storyTitle?.trim() || titleFallback(storyKey, t("sidebar.library", "คลังการ์ตูน"));
		const chapterLabel = resolveChapterLabel(projectBrowserGroups, route.projectId, storyKey)
			|| projectStore.project?.chapterLabel?.trim()
			|| projectStore.project?.name
			|| t("topbar.openChapter", "Open chapter");

		if (route.surface === "title") {
			return [
				{ label: dashboardLabel, target: { view: "dashboard" } },
				{ label: libraryLabel, target: { view: "library" } },
				{ label: storyLabel, current: true },
			];
		}

		if (route.surface === "language") {
			return [
				{ label: dashboardLabel, target: { view: "dashboard" } },
				{ label: libraryLabel, target: { view: "library" } },
				{ label: storyLabel, target: { view: "title", titleKey: storyKey } },
				{ label: route.language?.toUpperCase() ?? t("topbar.language", "Language"), current: true },
			];
		}

		if (route.surface === "chapter") {
			return [
				{ label: dashboardLabel, target: { view: "dashboard" } },
				{ label: storyLabel, target: { view: "title", titleKey: storyKey } },
				{ label: chapterLabel, current: true },
			];
		}

		if (route.projectId) {
			const currentLabelBySurface: Partial<Record<WorkspaceRouteTarget["surface"], string>> = {
				editor: t("topbar.surfaceEditor", "Edit page"),
				pages: t("topbar.surfacePages", "Pages / Export"),
				work: t("topbar.surfaceWork", "Team work"),
				import: "Import / Review",
				project: t("topbar.surfaceProject", "Chapter"),
			};
			const currentLabel = currentLabelBySurface[route.surface] ?? route.workspaceView;
			return [
				{ label: dashboardLabel, target: { view: "dashboard" } },
				{ label: storyLabel, target: { view: "title", titleKey: storyKey } },
				{ label: chapterLabel, target: { view: "chapter", titleKey: storyKey, projectId: route.projectId } },
				{ label: currentLabel, current: true },
			];
		}

		return [
			{ label: dashboardLabel, target: { view: "dashboard" } },
			{ label: route.workspaceView, current: true },
		];
	}
</script>

<svelte:window onkeydown={handleWindowKeydown} onclick={handleWindowClick} />

<header class="workspace-top-utility" aria-label={t("topbar.headerAria", "Search and account bar")}>
	<div class="workspace-command-dock ws-panel-quiet">
		<div class="workspace-top-lead">
			<button
				type="button"
				class="workspace-nav-toggle ws-btn-ghost rounded-ws-ctrl"
				aria-label={t("topbar.toggleNav", "Toggle navigation menu")}
				aria-expanded={editorUiStore.workspaceNavOpen}
				onclick={() => editorUiStore.toggleWorkspaceNav()}
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
					<path d="M4 6h16M4 12h16M4 18h16"/>
				</svg>
			</button>
			<WorkspaceBreadcrumb items={breadcrumbItems} onOpen={openBreadcrumbTarget} />
		</div>
		<div class="workspace-top-search ws-panel-quiet rounded-ws-ctrl" data-tour="search">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
				<circle cx="11" cy="11" r="7"/>
				<path d="m20 20-3.5-3.5"/>
			</svg>
			<input
				type="search"
				placeholder={searchPlaceholder}
				aria-label={searchAriaLabel}
				bind:value
				onkeydown={onKeydown}
			/>
			{#if value}
				<button type="button" class="ws-btn-ghost rounded-ws-ctrl" aria-label={t("topbar.clearSearch", "Clear search")} onclick={clearSearch}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
						<path d="M6 6l12 12M18 6 6 18"/>
					</svg>
				</button>
			{:else}
				<span>⌘ K</span>
			{/if}
			{#if searchPanel}
				{@render searchPanel()}
			{/if}
		</div>
		<div class="workspace-top-actions" aria-label={t("topbar.actionsAria", "System actions")}>
			<!-- AI credits meter — live when usageStore.dashboard is loaded -->
			<a class="workspace-top-credits" href="/settings/usage" title={aiTitle}>
				<div class="workspace-top-credits-head">
					<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
						<path d="M12 6l1.6 4.4L18 12l-4.4 1.6L12 18l-1.6-4.4L6 12l4.4-1.6z" fill="currentColor" fill-opacity="0.9"/>
					</svg>
					<span class="workspace-top-credits-label">AI credits</span>
					<span class="workspace-top-credits-value">
						{#if aiUnlimited}
							{t("topbar.unlimited", "ไม่จำกัด")}
						{:else}
							{aiRemainingLabel} <em>/ {aiLimitLabel}</em>
						{/if}
					</span>
					{#if hasPlanContext}
						<PlanBadge plan={planKey} size="xs" />
					{/if}
				</div>
				<div class="workspace-top-credits-track ws-track">
					<div class="workspace-top-credits-fill ws-fill" style={aiFillStyle}></div>
				</div>
			</a>

			{#if currentHelpTopic && helpPopoverId && helpTitleId && helpDescriptionId}
				<div class="workspace-help-anchor">
					<button
						bind:this={helpButton}
						type="button"
						class="workspace-top-icon workspace-help-trigger ws-btn-ghost rounded-ws-ctrl"
						aria-label={`${currentHelpTopic.title} help`}
						aria-haspopup="dialog"
						aria-expanded={helpOpen}
						aria-controls={helpOpen ? helpPopoverId : undefined}
						title={currentHelpTopic.oneLiner}
						onclick={togglePageHelp}
					>
						<strong aria-hidden="true">?</strong>
					</button>
					{#if helpOpen}
						<div
							bind:this={helpPopover}
							id={helpPopoverId}
							class="workspace-help-popover ws-panel-quiet rounded-ws-card"
							role="dialog"
							aria-labelledby={helpTitleId}
							aria-describedby={helpDescriptionId}
							tabindex="-1"
						>
							<div class="workspace-help-head">
								<div>
									<span>{t("topbar.pageHelpEyebrow", "Page help")}</span>
									<h2 id={helpTitleId}>{currentHelpTopic.title}</h2>
								</div>
								<button
									type="button"
									class="workspace-help-close ws-btn-ghost rounded-ws-ctrl"
									aria-label={`Close ${currentHelpTopic.title} help`}
									onclick={() => closePageHelp({ restoreFocus: true })}
								>
									<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
										<path d="M6 6l12 12M18 6 6 18"/>
									</svg>
								</button>
							</div>
							<p id={helpDescriptionId} class="workspace-help-one-liner">{currentHelpTopic.oneLiner}</p>
							<ol class="workspace-help-steps" aria-label={`${currentHelpTopic.title} steps`}>
								{#each currentHelpTopic.steps as step, index (step)}
									<li>
										<span aria-hidden="true">{index + 1}</span>
										<p>{step}</p>
									</li>
								{/each}
							</ol>
						</div>
					{/if}
				</div>
			{/if}

			<!-- live presence — pulses when SSE is connected (W2.7) -->
			<span
				class="workspace-top-icon workspace-top-live rounded-ws-ctrl"
				class:workspace-top-live-on={realtimeStore.connected}
				role="status"
				title={liveTitle}
				aria-label={liveTitle}
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
					<circle cx="12" cy="12" r="3" fill="currentColor"/>
					<path d="M5 12a7 7 0 0 1 14 0M2 12a10 10 0 0 1 20 0"/>
				</svg>
			</span>

			<!-- bell — opens the notification panel -->
			<button
				type="button"
				class="workspace-top-icon ws-btn-ghost rounded-ws-ctrl"
				aria-label={`${t("topbar.notifications", "Notifications")}${unreadCount > 0 ? ` (${unreadBadge} ${t("topbar.unread", "unread")})` : ""}`}
				title={recentActivityPreview || t("topbar.noNewActivity", "No new activity")}
				aria-expanded={editorUiStore.notificationPanelOpen}
				onclick={() => editorUiStore.toggleNotificationPanel()}
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
					<path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/>
					<path d="M13.73 21a2 2 0 0 1-3.46 0"/>
				</svg>
				{#if hasUnread}
					<small>{unreadBadge}</small>
				{:else if realtimeStore.connected}
					<i class="workspace-top-bell-dot" aria-hidden="true"></i>
				{/if}
			</button>

			<!-- ONE primary create -->
			{#if permissions.canCreateChapter}
			<button
				type="button"
				class="workspace-top-create ws-grad-primary rounded-ws-ctrl"
				class:is-resolving={!workspaceReady}
				aria-label={t("topbar.createAria", "Create new story/chapter")}
				aria-disabled={!workspaceReady}
				title={workspaceReady ? undefined : t("topbar.workspaceResolving", "กำลังตั้งค่าเวิร์กสเปซ… ลองอีกครั้งสักครู่")}
				onclick={handleCreate}
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
					<path d="M12 5v14M5 12h14"/>
				</svg>
				<span>{workspaceReady ? t("topbar.create", "Create") : t("topbar.workspaceResolvingShort", "Setting up…")}</span>
			</button>
			{/if}

			<!-- account menu → the shared AuthAccountMenu (account details, permissions,
			     sign in/out). Replaces the old dead avatar button, which had no handler. -->
			<div class="workspace-top-account">
				<AuthAccountMenu />
			</div>
		</div>
	</div>
</header>

<style>
	.workspace-top-utility {
		width: 100%;
		font-family: var(--font-ws-sans);
		/* Drive the responsive tightening off the bar's OWN available width, not
		   the viewport: the workspace nav rail narrows this column on desktop, so
		   a viewport-only breakpoint missed the real overflow (e.g. a 1280px
		   viewport leaves the bar ~976px wide and clipped the account menu).
		   The dock content column maxes out ≈1136px, so the slim-track band below
		   is what desktop sees — full-width desktop stays visually consistent and,
		   crucially, never clips the trailing cluster. */
		container-type: inline-size;
		container-name: wstopbar;
	}

	.workspace-command-dock {
		display: grid;
		grid-template-columns: minmax(190px, 0.9fr) minmax(240px, 480px) max-content;
		align-items: center;
		gap: 16px;
		min-height: 64px;
		padding: 10px 6px;
		border-width: 0 0 1px;
		background: color-mix(in srgb, var(--color-ws-bg) 78%, transparent);
		backdrop-filter: blur(14px);
		-webkit-backdrop-filter: blur(14px);
	}

	.workspace-top-lead {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	/* hamburger — only on narrow widths, drives the off-canvas nav drawer */
	.workspace-nav-toggle {
		display: none;
		flex-shrink: 0;
		width: 36px;
		height: 36px;
		align-items: center;
		justify-content: center;
		color: var(--color-ws-ink);
		cursor: pointer;
		transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
	}

	.workspace-nav-toggle svg {
		width: 18px;
		height: 18px;
		stroke-width: 1.8;
	}

	@media (max-width: 1024px) {
		.workspace-nav-toggle {
			display: inline-flex;
		}
	}

	/* ── centered search ── */
	.workspace-top-search {
		position: relative;
		min-height: 36px;
		display: grid;
		grid-template-columns: 18px minmax(0, 1fr) auto;
		align-items: center;
		gap: 10px;
		padding: 0 14px;
		background: var(--color-ws-surface);
	}

	.workspace-top-search svg {
		width: 16px;
		height: 16px;
		stroke-width: 1.6;
		color: var(--color-ws-faint);
	}

	.workspace-top-search input {
		min-width: 0;
		align-self: stretch;
		min-height: 36px;
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--color-ws-ink);
		font-family: inherit;
		font-size: 13px;
		font-weight: 500;
	}

	.workspace-top-search input::placeholder {
		color: var(--color-ws-faint);
	}

	.workspace-top-search > span {
		min-width: 28px;
		min-height: 22px;
		display: grid;
		place-items: center;
		padding: 0 6px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: transparent;
		color: var(--color-ws-faint);
		font-size: 11px;
		font-weight: 500;
		line-height: 1;
	}

	.workspace-top-search > button {
		min-width: 36px;
		min-height: 36px;
		display: grid;
		place-items: center;
		color: var(--color-ws-text);
		cursor: pointer;
	}

	.workspace-top-search > button:hover {
		color: var(--color-ws-ink);
	}

	/* ── right cluster ── */
	.workspace-top-actions {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: 12px;
		min-width: 0;
		padding-right: 6px;
	}

	/* AI credits meter */
	.workspace-top-credits {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding-right: 14px;
		margin-right: 2px;
		border-right: 1px solid var(--ws-hair);
		text-decoration: none;
		color: inherit;
	}
	.workspace-top-credits:hover .workspace-top-credits-label {
		color: var(--color-ws-ink);
	}

	.workspace-top-credits-head {
		display: flex;
		align-items: center;
		gap: 8px;
		line-height: 1;
	}

	.workspace-top-credits svg {
		width: 13px;
		height: 13px;
		color: var(--color-ws-accent);
	}

	.workspace-top-credits-label {
		font-size: 12px;
		color: var(--color-ws-text);
	}

	.workspace-top-credits-value {
		font-size: 12px;
		font-weight: 600;
		color: var(--color-ws-ink);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}

	.workspace-top-credits-value em {
		font-style: normal;
		font-weight: 400;
		color: var(--color-ws-faint);
	}

	.workspace-top-credits-track {
		width: 160px;
		height: 4px;
		border-radius: 999px;
		overflow: hidden;
	}

	.workspace-top-credits-fill {
		width: 0%;
		height: 100%;
		border-radius: 999px;
		transition: width 240ms ease-out;
	}

	/* icon buttons */
	.workspace-top-icon {
		position: relative;
		width: 36px;
		height: 36px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--color-ws-text);
		cursor: pointer;
		transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
	}

	.workspace-top-icon:hover {
		color: var(--color-ws-ink);
	}

	.workspace-top-icon svg {
		width: 17px;
		height: 17px;
		stroke-width: 1.6;
	}

	.workspace-top-icon small {
		position: absolute;
		top: -4px;
		right: -4px;
		min-width: 16px;
		height: 16px;
		display: grid;
		place-items: center;
		padding: 0 4px;
		border-radius: 999px;
		background: linear-gradient(100deg, var(--color-ws-violet) 0%, var(--color-ws-accent) 100%);
		color: var(--color-ws-ink);
		font-size: 10px;
		font-weight: 600;
		box-shadow: 0 0 0 2px var(--color-ws-bg);
		font-variant-numeric: tabular-nums;
	}

	.workspace-help-anchor {
		position: relative;
		display: inline-flex;
		flex: 0 0 auto;
	}

	.workspace-help-trigger strong {
		color: inherit;
		font-size: 15px;
		font-weight: 800;
		line-height: 1;
	}

	.workspace-help-popover {
		position: absolute;
		z-index: 1010;
		top: calc(100% + 10px);
		right: 0;
		width: min(330px, calc(100vw - 28px));
		padding: 14px;
		border: 1px solid var(--ws-hair-strong);
		background: color-mix(in srgb, var(--color-ws-surface2) 94%, var(--color-ws-bg));
		box-shadow: 0 22px 60px -32px color-mix(in srgb, var(--color-ws-bg) 92%, transparent);
		color: var(--color-ws-text);
	}

	.workspace-help-popover::before {
		content: "";
		position: absolute;
		top: -6px;
		right: 14px;
		width: 10px;
		height: 10px;
		border-top: 1px solid var(--ws-hair-strong);
		border-left: 1px solid var(--ws-hair-strong);
		background: inherit;
		transform: rotate(45deg);
	}

	.workspace-help-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}

	.workspace-help-head span {
		display: block;
		color: var(--color-ws-violet);
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	.workspace-help-head h2 {
		margin: 2px 0 0;
		color: var(--color-ws-ink);
		font-size: 16px;
		font-weight: 800;
		line-height: 1.2;
		letter-spacing: 0;
	}

	.workspace-help-close {
		width: 30px;
		height: 30px;
		display: inline-grid;
		flex: 0 0 auto;
		place-items: center;
		color: var(--color-ws-text);
		cursor: pointer;
	}

	.workspace-help-close:hover {
		color: var(--color-ws-ink);
	}

	.workspace-help-close svg {
		width: 15px;
		height: 15px;
		stroke-width: 1.8;
	}

	.workspace-help-one-liner {
		margin: 10px 0 0;
		color: var(--color-ws-text);
		font-size: 12px;
		font-weight: 600;
		line-height: 1.45;
	}

	.workspace-help-steps {
		display: grid;
		gap: 9px;
		margin: 12px 0 0;
		padding: 0;
		list-style: none;
	}

	.workspace-help-steps li {
		display: grid;
		grid-template-columns: 22px minmax(0, 1fr);
		gap: 9px;
		align-items: start;
	}

	.workspace-help-steps li > span {
		width: 22px;
		height: 22px;
		display: grid;
		place-items: center;
		border: 1px solid var(--ws-hair-strong);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-violet) 14%, transparent);
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 800;
		font-variant-numeric: tabular-nums;
	}

	.workspace-help-steps p {
		margin: 1px 0 0;
		color: var(--color-ws-faint);
		font-size: 12px;
		line-height: 1.4;
	}

	.workspace-top-bell-dot {
		position: absolute;
		top: 8px;
		right: 9px;
		width: 6px;
		height: 6px;
		border-radius: 999px;
		background: var(--color-ws-rose);
		box-shadow: 0 0 0 2px var(--color-ws-bg);
	}

	/* SSE live-presence pulse on the live indicator icon */
	.workspace-top-live {
		color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent);
		transition: color 0.18s ease;
	}

	.workspace-top-live.workspace-top-live-on {
		color: var(--color-ws-accent);
	}

	.workspace-top-live.workspace-top-live-on::after {
		content: "";
		position: absolute;
		top: 9px;
		right: 9px;
		width: 6px;
		height: 6px;
		border-radius: 999px;
		background: var(--color-ws-accent);
		box-shadow: 0 0 0 2px var(--color-ws-bg);
		animation: workspace-top-live-pulse 1.6s ease-in-out infinite;
	}

	@keyframes workspace-top-live-pulse {
		0%, 100% { opacity: 1; transform: scale(1); }
		50% { opacity: 0.45; transform: scale(0.7); }
	}

	@media (prefers-reduced-motion: reduce) {
		.workspace-top-live.workspace-top-live-on::after {
			animation: none;
		}
	}

	/* ONE primary create button */
	.workspace-top-create {
		position: relative;
		height: 36px;
		padding: 0 16px;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		border: 0;
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		box-shadow: 0 8px 24px -10px color-mix(in srgb, var(--color-ws-accent) 55%, transparent);
	}

	/* While the workspace is still resolving the Create button is gated (clicking
	   nudges a reload instead of opening the orphan-prone create dialog). */
	.workspace-top-create.is-resolving {
		background: linear-gradient(100deg,
			color-mix(in srgb, var(--color-ws-violet) 44%, var(--color-ws-surface2)),
			color-mix(in srgb, var(--color-ws-accent) 38%, var(--color-ws-surface2)));
		cursor: progress;
		opacity: 0.85;
		box-shadow: none;
	}

	.workspace-top-create svg {
		width: 15px;
		height: 15px;
		stroke-width: 2;
	}

	/* account menu (AuthAccountMenu) slot */
	.workspace-top-account {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
	}

	/* Tablet-landscape / narrow-rail band (bar available width ≈760–1100px):
	   covers iPad 1024 landscape (bar ≈960px) AND a 1280 viewport whose desktop
	   nav rail narrows this column to ≈976px. At full-width desktop the dock
	   content column caps ≈1136px (above this band), so the full three-column
	   layout with the credits track stays untouched there. In this band the
	   desktop grid no longer fits the credits track + icon row + Create +
	   account, so the trailing cluster clipped past the edge — tighten the grid,
	   gaps, and padding, and drop the (least-essential) progress track while
	   keeping the numeric credits value, so nothing clips. */
	@container wstopbar (min-width: 760px) and (max-width: 1100px) {
		.workspace-command-dock {
			grid-template-columns: minmax(150px, 0.7fr) minmax(160px, 1fr) max-content;
			gap: 10px;
			padding: 10px 8px;
		}

		.workspace-top-actions {
			gap: 8px;
		}

		.workspace-top-credits {
			padding-right: 10px;
		}

		.workspace-top-credits-track {
			display: none;
		}
	}

	/* Touch devices (coarse pointer) need a ≥44px hit target. The icons and the
	   nav toggle render at 36px for desktop density, so grow the hit area on
	   touch without changing the glyph size. width is also bumped on the narrow
	   bands below where there's room. */
	@media (pointer: coarse) {
		.workspace-top-icon,
		.workspace-nav-toggle {
			min-width: 44px;
			min-height: 44px;
			width: 44px;
			height: 44px;
		}

		.workspace-top-create {
			min-height: 44px;
			height: 44px;
		}
	}

	@media (max-width: 980px) {
		.workspace-command-dock {
			grid-template-columns: 1fr;
			gap: 10px;
		}

		.workspace-top-search {
			display: none;
		}

		/* group the actions neatly on the right instead of spreading them
		   edge-to-edge (which left big awkward gaps between the icons). */
		.workspace-top-actions {
			justify-content: flex-end;
			gap: 10px;
		}

		/* let the create button take the lead on mobile; keep icons compact. */
		.workspace-top-create {
			flex: 0 1 auto;
		}
	}

	@media (max-width: 760px) {
		.workspace-top-credits {
			display: none;
		}

		.workspace-help-popover {
			position: fixed;
			top: 74px;
			right: 14px;
			left: 14px;
			width: auto;
		}
	}
</style>
