<script lang="ts">
	import { onMount } from "svelte";
	import { _ } from "$lib/i18n";
	import { dialogFocus } from "$lib/components/Dialog.svelte";
	import type { ProjectSummary } from "$lib/api/client.js";
	import {
		formatRecentProjectDisambiguator,
		formatRecentProjectName,
		formatRecentProjectStats,
		formatRecentProjectUpdatedAt,
		getRecentProjectPickerItems,
		recentProjectNeedsPageSetup,
	} from "$lib/project/recent-projects.js";

	interface Props {
		projects: ProjectSummary[];
		selectedProjectId?: string;
		loading?: boolean;
		error?: string | null;
		onSelect: (projectId: string) => void;
		onRefresh?: () => void;
	}

	let {
		projects,
		selectedProjectId = "",
		loading = false,
		error = null,
		onSelect,
		onRefresh,
	}: Props = $props();

	let open = $state(false);
	let query = $state("");
	let rootEl: HTMLDivElement | null = $state(null);

	const selectedProject = $derived(projects.find((project) => project.projectId === selectedProjectId) ?? null);
	const pickerItems = $derived(getRecentProjectPickerItems(projects, query, selectedProjectId));
	const selectedDisambiguator = $derived(selectedProject ? formatRecentProjectDisambiguator(selectedProject, projects) : null);
	const triggerTitle = $derived(selectedProject
		? formatRecentProjectName(selectedProject)
		: loading
			? $_("recentProjectPicker.loading")
			: $_("recentProjectPicker.pickChapter"));
	const triggerFullTitle = $derived(selectedProject ? formatRecentProjectName(selectedProject) : triggerTitle);
	const triggerMeta = $derived(selectedProject
		? [formatRecentProjectStats(selectedProject), selectedDisambiguator].filter(Boolean).join(" / ")
		: loading
			? $_("recentProjectPicker.loadingDots")
			: projects.length
				? $_("recentProjectPicker.recentCount", { values: { count: projects.length } })
				: $_("recentProjectPicker.empty"));

	onMount(() => {
		function handlePointerDown(event: PointerEvent): void {
			if (!rootEl?.contains(event.target as Node)) {
				open = false;
			}
		}

		document.addEventListener("pointerdown", handlePointerDown);
		return () => document.removeEventListener("pointerdown", handlePointerDown);
	});

	function toggleOpen(): void {
		const nextOpen = !open;
		open = nextOpen;
		if (nextOpen && !loading && (error || projects.length === 0)) {
			onRefresh?.();
		}
		// Initial focus, focus-trap, Escape, and focus-restore-to-trigger are owned
		// by the shared `dialogFocus` action on the popover panel below.
	}

	function refreshProjects(): void {
		if (loading) return;
		onRefresh?.();
	}

	function selectProject(projectId: string): void {
		open = false;
		query = "";
		if (!projectId || projectId === selectedProjectId) return;
		onSelect(projectId);
	}
</script>

<div class="recent-project-picker" bind:this={rootEl}>
	<button
		type="button"
		class="recent-trigger"
		class:active={open}
		class:has-project={Boolean(selectedProject)}
		aria-haspopup="dialog"
		aria-expanded={open}
		aria-label={$_("recentProjectPicker.triggerLabel")}
		aria-busy={loading}
		title={triggerFullTitle}
		onclick={toggleOpen}
	>
		<span class="recent-trigger-glyph" aria-hidden="true">
			<span></span>
			<span></span>
			<span></span>
		</span>
		<span class="recent-trigger-copy">
			<span class="recent-trigger-kicker">{$_("recentProjectPicker.kicker")}</span>
			<span class="recent-trigger-title">{triggerTitle}</span>
		</span>
		<span class="recent-trigger-meta">{triggerMeta}</span>
		<span class="recent-trigger-caret" class:open aria-hidden="true"></span>
	</button>

	{#if open}
		<button
			type="button"
			class="recent-backdrop"
			aria-label={$_("recentProjectPicker.closeLabel")}
			onclick={() => open = false}
		></button>
		<div
			class="recent-menu"
			role="dialog"
			tabindex="-1"
			aria-label={$_("recentProjectPicker.dialogLabel")}
			use:dialogFocus={{ onEscape: () => (open = false) }}
		>
			<input
				bind:value={query}
				class="recent-search"
				id="recent-project-search"
				name="recentProjectSearch"
				type="search"
				placeholder={$_("recentProjectPicker.searchPlaceholder")}
				aria-label={$_("recentProjectPicker.searchLabel")}
				readonly={loading}
				aria-readonly={loading}
			/>

			{#if loading}
				<div class="recent-empty" role="status">
					{$_("recentProjectPicker.loadingList")}
				</div>
			{:else if error}
				<div class="recent-empty recent-error" role="status">
					<span>{error}</span>
					<button type="button" class="recent-retry" onclick={refreshProjects}>
						{$_("recentProjectPicker.retry")}
					</button>
				</div>
			{:else if pickerItems.projects.length}
				<div class="recent-list">
					{#each pickerItems.projects as project (project.projectId)}
						{@const needsPageSetup = recentProjectNeedsPageSetup(project)}
						{@const disambiguator = formatRecentProjectDisambiguator(project, projects)}
						{#if project.projectId === selectedProjectId}
							<div
								class="recent-row selected current-row"
								class:needs-setup={needsPageSetup}
								aria-current="true"
								aria-label={$_("recentProjectPicker.rowOpenLabel", { values: { name: formatRecentProjectName(project) } })}
								title={needsPageSetup ? $_("recentProjectPicker.needsSetupTitle") : [formatRecentProjectName(project), disambiguator].filter(Boolean).join(" / ")}
							>
								<span class="recent-row-main">
									<span class="recent-row-name">{formatRecentProjectName(project)}</span>
									{#if disambiguator}
										<span class="recent-row-code">{disambiguator}</span>
									{/if}
									<span class="recent-row-badge current">{$_("recentProjectPicker.badgeOpen")}</span>
									{#if needsPageSetup}
										<span class="recent-row-badge">{$_("recentProjectPicker.badgeAddPages")}</span>
									{/if}
								</span>
								<span class="recent-row-meta">{formatRecentProjectStats(project)}</span>
								<span class="recent-row-time">{formatRecentProjectUpdatedAt(project.updatedAt)}</span>
							</div>
						{:else}
							<button
								type="button"
								class="recent-row"
								class:needs-setup={needsPageSetup}
								onclick={() => selectProject(project.projectId)}
								title={needsPageSetup ? $_("recentProjectPicker.needsSetupTitle") : [formatRecentProjectName(project), disambiguator].filter(Boolean).join(" / ")}
							>
								<span class="recent-row-main">
									<span class="recent-row-name">{formatRecentProjectName(project)}</span>
									{#if disambiguator}
										<span class="recent-row-code">{disambiguator}</span>
									{/if}
									{#if needsPageSetup}
										<span class="recent-row-badge">{$_("recentProjectPicker.badgeAddPages")}</span>
									{/if}
								</span>
								<span class="recent-row-meta">{formatRecentProjectStats(project)}</span>
								<span class="recent-row-time">{formatRecentProjectUpdatedAt(project.updatedAt)}</span>
							</button>
						{/if}
					{/each}
				</div>
				{#if pickerItems.hiddenCount > 0}
					<div class="recent-more">
						{$_("recentProjectPicker.hiddenCount", { values: { count: pickerItems.hiddenCount } })}
					</div>
				{/if}
			{:else}
				<div class="recent-empty">
					{query.trim() ? $_("recentProjectPicker.noMatch") : $_("recentProjectPicker.empty")}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.recent-project-picker {
		position: relative;
		flex: 1 1 260px;
		width: min(320px, 30vw);
		min-width: 190px;
		max-width: 320px;
	}

	.recent-trigger {
		display: grid;
		grid-template-columns: 24px minmax(0, 1fr) auto 10px;
		align-items: center;
		width: 100%;
		min-height: 40px;
		gap: 7px;
		padding: 3px 8px 3px 5px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 8px;
		background: linear-gradient(180deg, rgba(255, 255, 255, 0.055), rgba(255, 255, 255, 0.025));
		color: var(--editor-text);
		cursor: pointer;
		text-align: left;
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
	}

	.recent-trigger.has-project {
		grid-template-columns: 24px minmax(0, 1fr) 10px;
	}

	.recent-trigger:hover,
	.recent-trigger.active {
		border-color: rgba(141, 187, 255, 0.34);
		background: rgba(71, 129, 213, 0.12);
	}

	.recent-trigger-glyph {
		display: inline-flex;
		flex-direction: column;
		gap: 3px;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 22px;
		border: 1px solid rgba(143, 184, 255, 0.18);
		border-radius: 6px;
		background: rgba(143, 184, 255, 0.08);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07);
	}

	.recent-trigger-glyph span {
		width: 11px;
		height: 2px;
		border-radius: 999px;
		background: #a9cfff;
		opacity: 0.86;
	}

	.recent-trigger-glyph span:nth-child(2) {
		width: 14px;
		opacity: 0.68;
	}

	.recent-trigger-glyph span:nth-child(3) {
		width: 8px;
		opacity: 0.5;
	}

	.recent-trigger-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 1px;
		line-height: 1;
	}

	.recent-trigger-kicker,
	.recent-trigger-meta {
		overflow: hidden;
		color: var(--editor-text-dim);
		font-size: 9px;
		font-weight: 800;
		line-height: 1;
		text-overflow: ellipsis;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.recent-trigger-kicker {
		display: block;
	}

	.recent-trigger-meta {
		max-width: 118px;
		text-align: right;
		text-transform: none;
	}

	.recent-trigger.has-project .recent-trigger-meta {
		display: none;
	}

	.recent-trigger-title {
		display: block;
		overflow: hidden;
		color: var(--editor-text);
		font-size: 11px;
		font-weight: 850;
		line-height: 1.2;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.recent-trigger-caret {
		width: 7px;
		height: 7px;
		border-right: 1.5px solid var(--editor-text-dim);
		border-bottom: 1.5px solid var(--editor-text-dim);
		transform: rotate(45deg);
		transition: transform 120ms ease, border-color 120ms ease;
	}

	.recent-trigger:hover .recent-trigger-caret,
	.recent-trigger.active .recent-trigger-caret {
		border-color: var(--editor-text);
	}

	.recent-trigger-caret.open {
		transform: rotate(225deg);
	}

	.recent-menu {
		position: absolute;
		top: calc(100% + 7px);
		left: 0;
		z-index: 240;
		width: min(440px, 88vw);
		padding: 8px;
		border: 1px solid rgba(142, 178, 225, 0.52);
		border-radius: 8px;
		background: color-mix(in srgb, var(--editor-surface) 88%, #05080d);
		box-shadow:
			0 24px 72px rgba(0, 0, 0, 0.64),
			0 0 0 1px rgba(255, 255, 255, 0.04),
			inset 0 1px 0 rgba(255, 255, 255, 0.07);
	}

	.recent-backdrop {
		position: fixed;
		inset: 56px 0 0;
		z-index: 230;
		min-width: 0;
		min-height: 0;
		padding: 0;
		border: 0;
		background: rgba(3, 6, 12, 0.42);
		backdrop-filter: blur(1.5px);
		cursor: default;
	}

	.recent-search {
		width: 100%;
		height: 40px;
		margin-bottom: 8px;
		padding: 0 9px;
		border: 1px solid var(--editor-border);
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.05);
		color: var(--editor-text);
		font-size: 12px;
		outline: none;
	}

	.recent-search:focus {
		border-color: rgba(120, 170, 220, 0.78);
		box-shadow: 0 0 0 2px rgba(80, 150, 220, 0.16);
	}

	.recent-search:read-only {
		color: var(--editor-text-dim);
		cursor: default;
	}

	.recent-list {
		display: grid;
		max-height: min(56vh, 480px);
		overflow: auto;
		gap: 4px;
	}

	.recent-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 4px 10px;
		width: 100%;
		padding: 8px;
		border: 1px solid transparent;
		border-radius: 5px;
		background: transparent;
		color: var(--editor-text);
		cursor: pointer;
		text-align: left;
	}

	button.recent-row:hover,
	.recent-row.selected {
		border-color: rgba(120, 170, 220, 0.48);
		background: rgba(90, 145, 210, 0.12);
	}

	.recent-row.current-row {
		cursor: default;
	}

	.recent-row-main {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 7px;
	}

	.recent-row-name {
		overflow: hidden;
		font-size: 12px;
		font-weight: 850;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.recent-row-badge {
		flex: 0 0 auto;
		min-height: 22px;
		padding: 3px 7px;
		border: 1px solid rgba(244, 188, 92, 0.28);
		border-radius: 999px;
		background: rgba(244, 188, 92, 0.12);
		color: #ffd998;
		font-size: 0.68rem;
		font-weight: 800;
	}

	.recent-row-badge.current {
		border-color: rgba(130, 220, 166, 0.28);
		background: rgba(130, 220, 166, 0.12);
		color: #b7f5cd;
	}

	.recent-row-code {
		flex: 0 0 auto;
		min-height: 22px;
		padding: 3px 7px;
		border: 1px solid rgba(142, 178, 225, 0.26);
		border-radius: 999px;
		background: rgba(142, 178, 225, 0.1);
		color: #bdd6ff;
		font-size: 0.68rem;
		font-weight: 800;
	}

	.recent-row.needs-setup {
		border-color: rgba(244, 188, 92, 0.22);
		background: linear-gradient(180deg, rgba(244, 188, 92, 0.08), rgba(15, 19, 29, 0.94));
	}

	.recent-row-meta,
	.recent-row-time {
		color: var(--editor-text-dim);
		font-size: 10px;
		font-weight: 750;
		line-height: 1.2;
	}

	.recent-row-time {
		text-align: right;
		white-space: nowrap;
	}

	.recent-more,
	.recent-empty {
		padding: 8px;
		color: var(--editor-text-dim);
		font-size: 11px;
		font-weight: 750;
	}

	.recent-error {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		color: #ffb4a8;
	}

	.recent-retry {
		flex: 0 0 auto;
		min-height: 40px;
		padding: 0 9px;
		border: 1px solid rgba(255, 180, 130, 0.35);
		border-radius: 4px;
		background: rgba(255, 140, 90, 0.12);
		color: #ffd7c8;
		cursor: pointer;
		font-size: 10px;
		font-weight: 850;
	}

	.recent-retry:hover {
		border-color: rgba(255, 200, 160, 0.58);
		background: rgba(255, 140, 90, 0.2);
	}

	@media (max-width: 900px) {
		.recent-project-picker {
			width: 180px;
			min-width: 150px;
		}

		.recent-trigger-meta {
			display: none;
		}
	}
</style>
