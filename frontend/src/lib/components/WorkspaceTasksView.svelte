<!-- WorkspaceTasksView - workspace-level list of every task assigned to the user.

	The dashboard intentionally shows only a compact My-Work slice. This surface
	uses the same workspace-home aggregate and row/opening helpers so task clicks
	stay cross-project-safe without adding a backend request. -->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import { queueWorkspaceHrefNavigation } from "$lib/navigation/workspace-navigation.js";
	import { hrefForWorkspaceView } from "$lib/navigation/workspace-routes.js";
	import {
		buildDashboardTaskRows,
		openDashboardTaskRowProjectFirst,
		type DashboardTaskRow,
		type DashboardTaskRowCopy,
	} from "$lib/project/workspace-dashboard.js";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { workspaceHomeStore } from "$lib/stores/workspace-home.svelte.ts";
	import type { WorkspaceHomeTask } from "$lib/api/client.js";
	import NumberValue from "$lib/components/ui/NumberValue.svelte";
	import WorkspacePageHeader from "$lib/components/ui/WorkspacePageHeader.svelte";
	import WorkspaceTopUtilityBar from "$lib/components/WorkspaceTopUtilityBar.svelte";

	type TaskFilter = "all" | "today" | "overdue";

	let activeFilter = $state<TaskFilter>("all");
	let searchQuery = $state("");
	let retryBusy = $state(false);

	let isActive = $derived(editorUiStore.workspaceView === "tasks");
	let homeLoaded = $derived(workspaceHomeStore.hasLoaded);
	let homeLoading = $derived(workspaceHomeStore.loading && !homeLoaded);
	let homeError = $derived(!homeLoaded && !workspaceHomeStore.loading ? workspaceHomeStore.error : null);
	let overdueTasks = $derived(workspaceHomeStore.myTasks.filter((task) => task.dueState === "overdue"));
	// "วันนี้" derives from the user's OWN myTasks rows — the dueToday aggregate
	// (dueState "soon" = due today/imminent per the api type) — the dueToday aggregate
	// is workspace-wide (anyone's open due tasks), so using it here would show
	// other members' work on a personal page (review #593 P2).
	let todayTasks = $derived(workspaceHomeStore.myTasks.filter((task) => task.dueState === "soon"));
	let sourceTasks = $derived.by((): WorkspaceHomeTask[] => {
		if (activeFilter === "today") return todayTasks;
		if (activeFilter === "overdue") return overdueTasks;
		return workspaceHomeStore.myTasks;
	});
	let allTaskRows = $derived(buildDashboardTaskRows(sourceTasks, taskRowCopy()));
	let normalizedSearchQuery = $derived(normalizeTaskSearch(searchQuery));
	let visibleTaskRows = $derived.by(() => {
		if (!normalizedSearchQuery) return allTaskRows;
		return allTaskRows.filter((row) => normalizeTaskSearch(row.title).includes(normalizedSearchQuery));
	});
	// The aggregate is server-capped at 60 my-tasks — say so instead of silently
	// truncating (review #593 P2; full pagination is a post-launch follow-up).
	let atServerCap = $derived(workspaceHomeStore.myTasks.length >= 60);
	let filterOptions = $derived([
		{ id: "all" as const, label: $_("tasksPage.filterAll"), count: workspaceHomeStore.myTasks.length },
		{ id: "today" as const, label: $_("tasksPage.filterToday"), count: todayTasks.length },
		{ id: "overdue" as const, label: $_("tasksPage.filterOverdue"), count: overdueTasks.length },
	]);

	function normalizeTaskSearch(value: string): string {
		return value.trim().toLocaleLowerCase();
	}

	function taskRowCopy(): DashboardTaskRowCopy {
		return {
			dueOverdue: $_("tasksPage.dueOverdue"),
			dueNone: $_("tasksPage.dueNone"),
			statusOverdue: $_("tasksPage.statusOverdue"),
			statusTodo: $_("tasksPage.statusTodo"),
			statusInProgress: $_("tasksPage.statusInProgress"),
			taskPageLane: (page) => $_("tasksPage.taskPageLane", { values: { page } }),
			taskTypePageTitle: (type, page) => $_("tasksPage.taskTypePageTitle", { values: { type, page } }),
		};
	}

	function rowContextLabel(row: DashboardTaskRow): string {
		const parts = row.lane.split(" · ");
		return parts.at(-1) ?? row.icon;
	}

	// #14: the page used to render one long flat, unsorted list of every task. Group it by
	// CHAPTER (each chapter = a projectId) and sort pages within a chapter, so it reads as a
	// hierarchy (story · chapter → its pages) instead of an overwhelming dump.
	function chapterGroupLabel(row: DashboardTaskRow): string {
		const parts = row.lane.split(" · ");
		return parts.length > 1 ? parts.slice(0, -1).join(" · ") : row.lane;
	}
	function pageOrder(row: DashboardTaskRow): number {
		const match = row.title.match(/(\d+)/);
		return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
	}
	let groupedTaskRows = $derived.by(() => {
		const byChapter = new Map<string, { projectId: string; label: string; rows: DashboardTaskRow[] }>();
		for (const row of visibleTaskRows) {
			const entry = byChapter.get(row.projectId) ?? { projectId: row.projectId, label: chapterGroupLabel(row), rows: [] };
			entry.rows.push(row);
			byChapter.set(row.projectId, entry);
		}
		const groups = [...byChapter.values()];
		for (const group of groups) group.rows.sort((a, b) => pageOrder(a) - pageOrder(b) || a.title.localeCompare(b.title));
		groups.sort((a, b) => a.label.localeCompare(b.label));
		return groups;
	});

	async function retryWorkspaceHome(): Promise<void> {
		if (retryBusy) return;
		retryBusy = true;
		try {
			await workspaceHomeStore.load(workspaceHomeStore.currentWorkspaceId);
		} finally {
			retryBusy = false;
		}
	}

	async function openTaskRow(row: DashboardTaskRow): Promise<void> {
		await openDashboardTaskRowProjectFirst(row, {
			currentProjectId: () => projectStore.project?.projectId,
			openProject: (projectId) => projectStore.openProject(projectId, editorStore.editor),
			openWorkBoard: () => editorUiStore.openWorkBoard(),
			openWorkBoardRoute: (projectId) => queueWorkspaceHrefNavigation(hrefForWorkspaceView("work", projectId)),
		});
	}
</script>

{#if isActive}
	<section class="ws-surface workspace-tasks-shell" aria-label={$_("tasksPage.surfaceAria")} data-testid="tasks-page">
		<div class="ws-surface-inner">
			<WorkspaceTopUtilityBar />
			<WorkspacePageHeader
				eyebrow={$_("tasksPage.eyebrow")}
				title={$_("tasksPage.title")}
				subtitle={$_("tasksPage.subtitle")}
			>
				{#snippet actions()}
					<span class="tasks-count-badge ws-grad-primary-soft">
						<NumberValue value={visibleTaskRows.length} /> {$_("tasksPage.tasksUnit")}
					</span>
				{/snippet}
			</WorkspacePageHeader>

			<div class="tasks-toolbar ws-panel rounded-ws-card" data-testid="tasks-page-toolbar">
				<div class="tasks-filter-row" aria-label={$_("tasksPage.filtersAria")}>
					{#each filterOptions as option (option.id)}
						<button
							type="button"
							class="tasks-filter-chip"
							class:active={activeFilter === option.id}
							aria-pressed={activeFilter === option.id}
							onclick={() => activeFilter = option.id}
						>
							<span>{option.label}</span>
							<small><NumberValue value={option.count} /></small>
						</button>
					{/each}
				</div>
				<label class="tasks-search">
					<span>{$_("tasksPage.searchLabel")}</span>
					<input
						type="search"
						bind:value={searchQuery}
						placeholder={$_("tasksPage.searchPlaceholder")}
						aria-label={$_("tasksPage.searchAria")}
					/>
				</label>
			</div>

			{#if homeLoading}
				<div class="tasks-state ws-panel rounded-ws-card" data-testid="tasks-page-loading">
					<p>{$_("tasksPage.loading")}</p>
				</div>
			{:else if homeError}
				<div class="tasks-state ws-panel rounded-ws-card" data-testid="tasks-page-error" role="alert">
					<p>{$_("tasksPage.errorTitle")}</p>
					<small>{homeError}</small>
					{#if retryBusy}
						<span class="tasks-retry-receipt">{$_("tasksPage.retrying")}</span>
					{:else}
						<button type="button" class="ws-btn-ghost rounded-ws-ctrl" onclick={() => void retryWorkspaceHome()}>{$_("tasksPage.retry")}</button>
					{/if}
				</div>
			{:else if workspaceHomeStore.myTasks.length === 0}
				<div class="tasks-state ws-panel rounded-ws-card" data-testid="tasks-page-empty">
					<p>{$_("tasksPage.emptyTitle")}</p>
					<small>{$_("tasksPage.emptyDetail")}</small>
				</div>
			{:else if visibleTaskRows.length === 0}
				<div class="tasks-state ws-panel rounded-ws-card" data-testid="tasks-page-no-results">
					<p>{$_("tasksPage.noResultsTitle")}</p>
					<small>{$_("tasksPage.noResultsDetail")}</small>
				</div>
			{:else}
				<div class="tasks-list" data-testid="tasks-page-list">
					{#each groupedTaskRows as group (group.projectId)}
						<section class="flex flex-col gap-2">
							<header class="flex items-center justify-between px-1 pt-2 text-[11px] font-bold uppercase tracking-wide text-ws-faint">
								<span class="truncate">{group.label}</span>
								<span class="tabular-nums">{group.rows.length}</span>
							</header>
							{#each group.rows as row (row.id)}
						<button
							type="button"
							class="tasks-row ws-panel ws-row-hover"
							data-testid="tasks-page-row"
							aria-label={$_("tasksPage.openTaskAria", { values: { title: row.title } })}
							onclick={() => void openTaskRow(row)}
						>
							<span class="tasks-row-context ws-tag-{row.accent}">{rowContextLabel(row)}</span>
							<span class="tasks-row-main">
								<span class="tasks-row-title" title={row.title}>{row.title}</span>
								<span class="tasks-row-lane">{row.lane}</span>
							</span>
							<span class="tasks-row-meta">
								<span class:late={row.statusClass === "late"} class:soon={row.statusClass === "soon"}>{row.due}</span>
								<small>{row.status}</small>
							</span>
							<span class="tasks-row-progress" aria-hidden="true">
								<span style={`width: ${row.progress}%`}></span>
							</span>
						</button>
							{/each}
						</section>
					{/each}
				</div>
			{/if}
		</div>
		{#if atServerCap}
		<p class="text-[11.5px] text-ws-faint px-1 pb-2">{$_("tasksPage.serverCapNote")}</p>
	{/if}
</section>
{/if}

<style>
	.workspace-tasks-shell {
		color: var(--color-ws-text);
	}

	.tasks-count-badge {
		display: inline-flex;
		min-height: 34px;
		align-items: center;
		gap: 6px;
		border-radius: var(--radius-ws-ctrl);
		padding: 0 12px;
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 800;
		white-space: nowrap;
	}

	.tasks-toolbar {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(220px, 340px);
		gap: 14px;
		align-items: center;
		margin-bottom: 16px;
		padding: 14px;
	}

	.tasks-filter-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.tasks-filter-chip {
		display: inline-flex;
		min-height: 36px;
		align-items: center;
		gap: 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-line) 80%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface) 72%, transparent);
		color: var(--color-ws-text);
		padding: 0 11px;
		font-size: 12px;
		font-weight: 800;
		cursor: pointer;
		transition: border-color 150ms ease, color 150ms ease, background 150ms ease;
	}

	.tasks-filter-chip small {
		color: var(--color-ws-faint);
		font-size: 11px;
		font-weight: 800;
	}

	.tasks-filter-chip.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 56%, var(--color-ws-line));
		background: color-mix(in srgb, var(--color-ws-accent) 15%, var(--color-ws-surface));
		color: var(--color-ws-ink);
	}

	.tasks-search {
		display: grid;
		gap: 6px;
	}

	.tasks-search span {
		color: var(--color-ws-faint);
		font-size: 11px;
		font-weight: 800;
		text-transform: uppercase;
	}

	.tasks-search input {
		width: 100%;
		min-height: 38px;
		border: 1px solid color-mix(in srgb, var(--color-ws-line) 85%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-bg) 42%, var(--color-ws-surface));
		color: var(--color-ws-ink);
		padding: 0 12px;
		font-size: 13px;
		outline: none;
	}

	.tasks-search input:focus {
		border-color: color-mix(in srgb, var(--color-ws-accent) 70%, var(--color-ws-line));
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-ws-accent) 16%, transparent);
	}

	.tasks-list {
		display: grid;
		gap: 10px;
	}

	.tasks-row {
		position: relative;
		display: grid;
		grid-template-columns: minmax(76px, 104px) minmax(0, 1fr) minmax(128px, auto);
		gap: 14px;
		align-items: center;
		width: 100%;
		min-height: 72px;
		border-radius: var(--radius-ws-card);
		padding: 12px 14px 14px;
		text-align: left;
		color: inherit;
		cursor: pointer;
	}

	.tasks-row-context {
		display: inline-flex;
		min-height: 28px;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		padding: 0 9px;
		font-size: 11px;
		font-weight: 900;
		white-space: nowrap;
	}

	.tasks-row-main {
		min-width: 0;
	}

	.tasks-row-title,
	.tasks-row-lane {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tasks-row-title {
		color: var(--color-ws-ink);
		font-size: 14px;
		font-weight: 800;
	}

	.tasks-row-lane {
		margin-top: 3px;
		color: var(--color-ws-faint);
		font-size: 12px;
	}

	.tasks-row-meta {
		display: grid;
		gap: 2px;
		justify-items: end;
		color: var(--color-ws-text);
		font-size: 12px;
		font-weight: 800;
		white-space: nowrap;
	}

	.tasks-row-meta small {
		color: var(--color-ws-faint);
		font-size: 11px;
		font-weight: 800;
	}

	.tasks-row-meta .late {
		color: var(--color-ws-rose);
	}

	.tasks-row-meta .soon {
		color: var(--color-ws-amber);
	}

	.tasks-row-progress {
		position: absolute;
		right: 14px;
		bottom: 8px;
		left: 14px;
		height: 3px;
		overflow: hidden;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-line) 58%, transparent);
	}

	.tasks-row-progress span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: linear-gradient(90deg, var(--color-ws-accent), var(--color-ws-green));
	}

	.tasks-state {
		display: grid;
		min-height: 180px;
		place-items: center;
		align-content: center;
		gap: 8px;
		padding: 28px;
		text-align: center;
	}

	.tasks-state p {
		margin: 0;
		color: var(--color-ws-ink);
		font-size: 15px;
		font-weight: 900;
	}

	.tasks-state small {
		max-width: 520px;
		color: var(--color-ws-faint);
		font-size: 12px;
		line-height: 1.5;
	}

	.tasks-retry-receipt {
		display: inline-flex;
		min-height: 34px;
		align-items: center;
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-line) 40%, transparent);
		color: var(--color-ws-faint);
		padding: 0 12px;
		font-size: 12px;
		font-weight: 800;
	}

	@media (max-width: 760px) {
		.tasks-toolbar,
		.tasks-row {
			grid-template-columns: 1fr;
		}

		.tasks-row {
			gap: 8px;
		}

		.tasks-row-context {
			width: fit-content;
		}

		.tasks-row-meta {
			justify-items: start;
		}
	}
</style>
