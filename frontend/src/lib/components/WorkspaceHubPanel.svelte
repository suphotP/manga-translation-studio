<script lang="ts">
	import { formatWorkflowDueDay } from "$lib/project/task-due.js";
	import {
		WORKSPACE_FEED_FILTERS,
		countWorkspaceFeedFilterItems,
		filterWorkspaceFeedItems,
		workspaceFeedFilterEmptyCopy,
		type WorkspaceFeedFilter,
	} from "$lib/project/workspace-feed-filters.js";
	import { workspaceFeedItemActionLabel } from "$lib/project/work-targets.js";
	import type { WorkspaceFeedItem } from "$lib/types.js";
	import ScopeToggle from "./ScopeToggle.svelte";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { _ } from "$lib/i18n";

	type WorkspaceHubScope = "page" | "all";

	interface Props {
		projectOpen: boolean;
		totalEventCount: number;
		pageEventCount: number;
		loading: boolean;
		note: string;
		items: WorkspaceFeedItem[];
		scope: WorkspaceHubScope;
		filter: WorkspaceFeedFilter;
		selectedItemId: string | null;
		kindLabel: (kind: WorkspaceFeedItem["kind"]) => string;
		timeLabel: (value: string) => string;
		isActionable: (item: WorkspaceFeedItem) => boolean;
		onNoteChange: (value: string) => void;
		onScopeChange: (scope: WorkspaceHubScope) => void;
		onFilterChange: (filter: WorkspaceFeedFilter) => void;
		onSync: () => void;
		onAddHandoff: () => void;
		onOpenItem: (item: WorkspaceFeedItem) => void;
		soloMode?: boolean;
	}

	let {
		projectOpen,
		totalEventCount,
		pageEventCount,
		loading,
		note,
		items,
		scope,
		filter,
		selectedItemId,
		kindLabel,
		timeLabel,
		isActionable,
		onNoteChange,
		onScopeChange,
		onFilterChange,
		onSync,
		onAddHandoff,
		onOpenItem,
		soloMode,
	}: Props = $props();

	let isSoloMode = $derived(soloMode ?? (editorUiStore.workspaceMode === "solo"));

	let filteredItems = $derived(filterWorkspaceFeedItems(items, filter));
	let filterCounts = $derived({
		all: countWorkspaceFeedFilterItems(items, "all"),
		attention: countWorkspaceFeedFilterItems(items, "attention"),
		due: countWorkspaceFeedFilterItems(items, "due"),
		tasks: countWorkspaceFeedFilterItems(items, "tasks"),
		exports: countWorkspaceFeedFilterItems(items, "exports"),
		notes: countWorkspaceFeedFilterItems(items, "notes"),
	});
	let focusedFeedItem = $derived(
		filteredItems.find((item) => item.id === selectedItemId)
			?? filteredItems.find((item) => isActionable(item))
			?? filteredItems[0]
			?? null
	);
	let visibleFeedItems = $derived(getVisibleFeedItems());
	let hiddenFeedCount = $derived(Math.max(0, filteredItems.length - visibleFeedItems.length));
	let showFeedList = $state(false);

	function getVisibleFeedItems(): WorkspaceFeedItem[] {
		if (!focusedFeedItem) return filteredItems.slice(0, 8);
		const firstItems = filteredItems.slice(0, 8);
		if (firstItems.some((item) => item.id === focusedFeedItem.id)) return firstItems;
		return [focusedFeedItem, ...firstItems.slice(0, 7)];
	}

	function updateNote(event: Event): void {
		onNoteChange((event.currentTarget as HTMLTextAreaElement).value);
	}

	function dueStateLabel(item: WorkspaceFeedItem): string {
		if (item.dueState === "overdue") return $_("workspaceHub.dueOverdue");
		if (item.dueState === "soon") return $_("workspaceHub.dueSoon");
		return $_("workspaceHub.dueOnTime");
	}

	function priorityLabel(value: string): string {
		const labels: Record<string, string> = {
			urgent: $_("workspaceHub.priorityUrgent"),
			high: $_("workspaceHub.priorityHigh"),
			low: $_("workspaceHub.priorityLow"),
			normal: $_("workspaceHub.priorityNormal"),
		};
		return labels[value] ?? hubInlineCopy(value);
	}

	function pageChipLabel(pageIndex: number): string {
		return $_("workspaceHub.pageN", { values: { n: pageIndex + 1 } });
	}

	function feedTitleLabel(item: WorkspaceFeedItem): string {
		// Producer: maps English (or already-Thai) feed titles to localized display.
		const pageLabel = item.pageIndex === undefined ? $_("workspaceHub.thisTask") : $_("workspaceHub.pageN", { values: { n: item.pageIndex + 1 } });
		// SENTINEL: the /^หน้า …/ regex strips an already-Thai "หน้า N - " prefix
		// that this same producer can emit; it matches Thai text by value, so keep it.
		const title = item.title.replace(/^Page\s+\d+\s*-\s*/i, "").replace(/^หน้า\s+\d+\s*-\s*/i, "");
		if (/^Translate page \d+$/i.test(title)) return $_("workspaceHub.titleTranslate", { values: { page: pageLabel } });
		if (/^Clean page \d+$/i.test(title)) return $_("workspaceHub.titleClean", { values: { page: pageLabel } });
		if (/^Typeset page \d+$/i.test(title)) return $_("workspaceHub.titleTypeset", { values: { page: pageLabel } });
			if (/^Review page \d+$/i.test(title)) return $_("workspaceHub.titleReview", { values: { page: pageLabel } });
		if (/^Translate page$/i.test(title)) return $_("workspaceHub.titleTranslate", { values: { page: pageLabel } });
		if (/^Clean page$/i.test(title)) return $_("workspaceHub.titleClean", { values: { page: pageLabel } });
		if (/^Typeset page$/i.test(title)) return $_("workspaceHub.titleTypeset", { values: { page: pageLabel } });
			if (/^Review page$/i.test(title)) return $_("workspaceHub.titleReview", { values: { page: pageLabel } });
		if (/^Export failed$/i.test(title)) return $_("workspaceHub.exportFailed");
			if (/^Task moved to review$/i.test(title)) return $_("workspaceHub.taskMovedToReview");
		return hubInlineCopy(item.title.replace(/^Page\s+(\d+)\s*-\s*/i, `${$_("workspaceHub.pageN", { values: { n: "$1" } })}: `));
	}

	function feedDetailLabel(item: WorkspaceFeedItem): string {
		return hubInlineCopy(item.detail);
	}

	function mentionLabel(mention: string): string {
		const labels: Record<string, string> = {
			solo: "Solo",
			"local-user": $_("workspaceHub.mentionYou"),
			qa: "QA",
			qc: "QC",
		};
		return labels[mention.toLowerCase()] ?? mention;
	}

	function hubInlineCopy(value: string): string {
		// Producer: rewrites English/snake_case event source text to localized
		// display. Replacement values carry "$N" regex backreferences as the {n}
		// token value so they survive i18n interpolation into the regex replace.
		return value
				.replace(/\bTask moved to review\b/gi, $_("workspaceHub.taskMovedToReview"))
			.replace(/\bExport failed\b/gi, $_("workspaceHub.exportFailed"))
			.replace(/\bversion_restored\b/gi, $_("workspaceHub.copyVersionRestored"))
			.replace(/\bcomment_resolved\b/gi, $_("workspaceHub.copyCommentResolved"))
			.replace(/\bcomment_added\b/gi, $_("workspaceHub.copyCommentAdded"))
			.replace(/\btask_updated\b/gi, $_("workspaceHub.copyTaskUpdated"))
			.replace(/\bassignee\b/gi, $_("workspaceHub.copyAssignee"))
			.replace(/\bunassigned\b/gi, $_("workspaceHub.copyUnassigned"))
				.replace(/\bopen review comments?\b/gi, $_("workspaceHub.copyOpenReviewComments"))
				.replace(/\bReviewer note\b/gi, $_("workspaceHub.copyReviewerNote"))
			.replace(/\bReview page (\d+)\b/gi, $_("workspaceHub.copyReviewPage", { values: { n: "$1" } }))
			.replace(/\bClean page (\d+)\b/gi, $_("workspaceHub.copyCleanPage", { values: { n: "$1" } }))
			.replace(/\bTypeset page (\d+)\b/gi, $_("workspaceHub.copyTypesetPage", { values: { n: "$1" } }))
			.replace(/\bTranslate page (\d+)\b/gi, $_("workspaceHub.copyTranslatePage", { values: { n: "$1" } }))
			.replace(/\bPage (\d+)\b/g, $_("workspaceHub.copyPageN", { values: { n: "$1" } }))
			.replace(/\bpages\b/gi, $_("workspaceHub.copyPageWord"))
			.replace(/\bpage\b/gi, $_("workspaceHub.copyPageWord"))
			.replace(/\btodo\b/gi, $_("workspaceHub.copyTodo"))
			.replace(/\bdoing\b/gi, $_("workspaceHub.copyDoing"))
			.replace(/\bdone\b/gi, $_("workspaceHub.copyDone"))
			.replace(/\bnormal\b/gi, $_("workspaceHub.copyNormal"))
			.replace(/\boverdue\b/gi, $_("workspaceHub.copyOverdue"))
			.replace(/\bdue soon\b/gi, $_("workspaceHub.copyDueSoon"))
			.replace(/\burgent\b/gi, $_("workspaceHub.copyUrgent"))
			.replace(/\bhigh\b/gi, $_("workspaceHub.copyHigh"))
			.replace(/@local-user\b/g, $_("workspaceHub.copyMentionYou"))
			.replace(/@solo\b/g, $_("workspaceHub.copyMentionSolo"))
			.replace(/@qa\b/gi, "QA")
			.replace(/@qc\b/gi, "QC")
			.replace(/\bcomments?\b/gi, $_("workspaceHub.copyCommentWord"))
			.replace(/\bText layers?\b/g, $_("workspaceHub.copyTextLayers"));
	}

	function openFeedItem(item: WorkspaceFeedItem): void {
		if (!isActionable(item)) return;
		onOpenItem(item);
	}
</script>

<div class="workspace-hub-panel">
	<div class="workspace-hub-summary">
		<span>{$_("workspaceHub.pageUpdates", { values: { n: pageEventCount } })}</span>
		<span>{$_("workspaceHub.allUpdates", { values: { n: totalEventCount } })}</span>
		{#if projectOpen && !loading}
			<button class="layer-action-btn" onclick={onSync}>{$_("workspaceHub.sync")}</button>
		{:else}
			<span class="workspace-action-receipt">{projectOpen ? $_("workspaceHub.syncing") : $_("workspaceHub.openWorkToSync")}</span>
		{/if}
	</div>
	{#if !isSoloMode}
		<ScopeToggle label={$_("workspaceHub.teamUpdateScope")} value={scope} onChange={onScopeChange} />
	{/if}
	<div class="workspace-feed-filters" role="group" aria-label={isSoloMode ? $_("workspaceHub.filterAriaSolo") : $_("workspaceHub.filterAriaTeam")}>
		{#each WORKSPACE_FEED_FILTERS as option (option.id)}
			{#if projectOpen && !loading}
				<button
					type="button"
					class:active={filter === option.id}
					aria-pressed={filter === option.id}
					onclick={() => onFilterChange(option.id)}
				>
					<span>{option.label}</span>
					<em>{filterCounts[option.id]}</em>
				</button>
			{:else}
				<span class="workspace-filter-receipt" class:active={filter === option.id}>
					<span>{option.label}</span>
					<em>{filterCounts[option.id]}</em>
				</span>
			{/if}
		{/each}
	</div>
	{#if !isSoloMode}
		<details class="workspace-note-drawer" open={Boolean(note.trim())}>
			<summary>
				<span>{$_("workspaceHub.handoffNote")}</span>
				<em>{$_("workspaceHub.teamNote")}</em>
			</summary>
			<textarea
				class="workspace-note-input"
				value={note}
				rows="2"
				placeholder={$_("workspaceHub.handoffPlaceholder")}
				readonly={!projectOpen || loading}
				aria-label={$_("workspaceHub.handoffAria")}
				oninput={updateNote}
			></textarea>
			{#if projectOpen && !loading && note.trim()}
				<button class="layer-action-btn workspace-note-btn" onclick={onAddHandoff}>
					{$_("workspaceHub.addHandoff")}
				</button>
			{:else}
				<span class="workspace-action-receipt">
					{projectOpen ? loading ? $_("workspaceHub.syncingNote") : $_("workspaceHub.typeNoteBeforeHandoff") : $_("workspaceHub.openWorkBeforeHandoff")}
				</span>
			{/if}
		</details>
	{/if}

	{#if !projectOpen}
		<div class="empty-state">
			<strong>{$_("workspaceHub.openWorkFirst")}</strong>
			<span>{isSoloMode ? $_("workspaceHub.openToSeeTaskUpdates") : $_("workspaceHub.openToSeeTeamUpdates")}</span>
		</div>
	{:else if loading && !items.length}
		<div class="empty-state">{isSoloMode ? $_("workspaceHub.loadingTaskUpdates") : $_("workspaceHub.loadingTeamUpdates")}</div>
	{:else if !items.length}
		<div class="empty-state">
			<strong>{scope === "all" ? $_("workspaceHub.noUpdatesChapter") : $_("workspaceHub.noUpdatesPage")}</strong>
			<span>{scope === "all" ? (isSoloMode ? $_("workspaceHub.noChapterUpdatesSolo") : $_("workspaceHub.noChapterUpdatesTeam")) : (isSoloMode ? $_("workspaceHub.noPageUpdatesSolo") : $_("workspaceHub.noPageUpdatesTeam"))}</span>
		</div>
	{:else if !filteredItems.length}
		<div class="empty-state">{workspaceFeedFilterEmptyCopy(filter, scope)}</div>
	{:else}
		{#if focusedFeedItem}
			<section
				class={`workspace-feed-focus ${focusedFeedItem.severity ?? "info"}`}
				class:passive={!isActionable(focusedFeedItem)}
				aria-label={isSoloMode ? $_("workspaceHub.focusAriaSolo") : $_("workspaceHub.focusAriaTeam")}
			>
				<div class="workspace-feed-focus-copy">
					<span>{isActionable(focusedFeedItem) ? (isSoloMode ? $_("workspaceHub.focusActionableSolo") : $_("workspaceHub.focusActionableTeam")) : $_("workspaceHub.focusReadOnlyTag")}</span>
					<strong>{feedTitleLabel(focusedFeedItem)}</strong>
					<small>{timeLabel(focusedFeedItem.createdAt)}</small>
					<div class="workspace-feed-meta-row">
						<span class="workspace-feed-kind-chip">{kindLabel(focusedFeedItem.kind)}</span>
						<span class="workspace-feed-action-chip">
							{workspaceFeedItemActionLabel(focusedFeedItem)}
						</span>
						{#if focusedFeedItem.pageIndex !== undefined}
							<span class="workspace-feed-page-chip">{pageChipLabel(focusedFeedItem.pageIndex)}</span>
						{/if}
						{#if focusedFeedItem.dueAt}
							<em class={`due-chip ${focusedFeedItem.dueState ?? "scheduled"}`}>
								{dueStateLabel(focusedFeedItem)} {formatWorkflowDueDay(focusedFeedItem.dueAt)}
							</em>
						{/if}
						{#if !isSoloMode && focusedFeedItem.mentions?.length}
							<div class="workspace-feed-mentions" aria-label={$_("workspaceHub.mentionFocusAria")}>
								{#each focusedFeedItem.mentions as mention (mention)}
									<em>{mentionLabel(mention)}</em>
								{/each}
							</div>
						{/if}
					</div>
				</div>
				{#if isActionable(focusedFeedItem)}
					<button
						type="button"
						onclick={() => openFeedItem(focusedFeedItem)}
						aria-label={isSoloMode ? $_("workspaceHub.openTaskUpdateAria", { values: { title: feedTitleLabel(focusedFeedItem) } }) : $_("workspaceHub.openTeamUpdateAria", { values: { title: feedTitleLabel(focusedFeedItem) } })}
					>
						{$_("workspaceHub.open")}
					</button>
				{:else}
					<span class="workspace-action-receipt">{$_("workspaceHub.readOnly")}</span>
				{/if}
			</section>
		{/if}

		<div class="workspace-feed-drawer">
			<button
				type="button"
				class="workspace-feed-drawer-toggle"
				aria-expanded={showFeedList}
				onclick={() => showFeedList = !showFeedList}
			>
				<span>{$_("workspaceHub.updateQueue")}</span>
				<em>{filteredItems.length}{hiddenFeedCount ? ` ${$_("workspaceHub.hiddenSuffix", { values: { n: hiddenFeedCount } })}` : ""}</em>
			</button>
			{#if showFeedList}
				<div class="workspace-feed-list">
					{#each visibleFeedItems as item (item.id)}
						{#if isActionable(item)}
							<button
								type="button"
								class={`workspace-feed-row ${item.severity ?? "info"}`}
								class:actionable={true}
								class:selected={selectedItemId === item.id}
								onclick={() => openFeedItem(item)}
							>
								<div class="workspace-feed-main">
									<div class="workspace-feed-title-row">
										<span>{kindLabel(item.kind)}</span>
										<strong>{feedTitleLabel(item)}</strong>
										<time>{timeLabel(item.createdAt)}</time>
									</div>
									<small>{feedDetailLabel(item)}</small>
									<div class="workspace-feed-meta-row">
										<span class="workspace-feed-action-chip">
											{workspaceFeedItemActionLabel(item)}
										</span>
										{#if item.pageIndex !== undefined}
											<span class="workspace-feed-page-chip">{pageChipLabel(item.pageIndex)}</span>
										{/if}
									</div>
									{#if item.priority && item.priority !== "normal"}
										<em class={`priority-chip ${item.priority}`}>{priorityLabel(item.priority)}</em>
									{/if}
									{#if item.dueAt}
										<em class={`due-chip ${item.dueState ?? "scheduled"}`}>
											{dueStateLabel(item)} {formatWorkflowDueDay(item.dueAt)}
										</em>
									{/if}
									{#if !isSoloMode && item.mentions?.length}
										<div class="workspace-feed-mentions" aria-label={$_("workspaceHub.mentionInTeamUpdate")}>
											{#each item.mentions as mention (mention)}
												<em>{mentionLabel(mention)}</em>
											{/each}
										</div>
									{/if}
								</div>
							</button>
						{:else}
							<article
								class={`workspace-feed-row ${item.severity ?? "info"} passive`}
								class:selected={selectedItemId === item.id}
								aria-label={isSoloMode ? $_("workspaceHub.readTaskUpdateAria", { values: { title: feedTitleLabel(item) } }) : $_("workspaceHub.readTeamUpdateAria", { values: { title: feedTitleLabel(item) } })}
							>
								<div class="workspace-feed-main">
									<div class="workspace-feed-title-row">
										<span>{kindLabel(item.kind)}</span>
										<strong>{feedTitleLabel(item)}</strong>
										<time>{timeLabel(item.createdAt)}</time>
									</div>
									<small>{feedDetailLabel(item)}</small>
									<div class="workspace-feed-meta-row">
										<span class="workspace-feed-action-chip">
											{workspaceFeedItemActionLabel(item)}
										</span>
										{#if item.pageIndex !== undefined}
											<span class="workspace-feed-page-chip">{pageChipLabel(item.pageIndex)}</span>
										{/if}
									</div>
									{#if item.priority && item.priority !== "normal"}
										<em class={`priority-chip ${item.priority}`}>{priorityLabel(item.priority)}</em>
									{/if}
									{#if item.dueAt}
										<em class={`due-chip ${item.dueState ?? "scheduled"}`}>
											{dueStateLabel(item)} {formatWorkflowDueDay(item.dueAt)}
										</em>
									{/if}
									{#if !isSoloMode && item.mentions?.length}
										<div class="workspace-feed-mentions" aria-label={$_("workspaceHub.mentionInTeamUpdate")}>
											{#each item.mentions as mention (mention)}
												<em>{mentionLabel(mention)}</em>
											{/each}
										</div>
									{/if}
								</div>
							</article>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.workspace-hub-panel {
		display: flex;
		flex-direction: column;
		gap: 10px;
		color: var(--color-ws-ink);
	}

	.workspace-hub-summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 720;
	}

	.layer-action-btn {
		min-height: 40px;
		min-width: 0;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 42%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: linear-gradient(100deg, var(--color-ws-violet), color-mix(in srgb, var(--color-ws-rose) 72%, var(--color-ws-violet)));
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 850;
		line-height: 1;
		cursor: pointer;
		box-shadow: 0 10px 24px -18px color-mix(in srgb, var(--color-ws-accent) 78%, transparent);
	}

	.layer-action-btn:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 64%, transparent);
		filter: brightness(1.07);
	}

	.workspace-hub-summary .layer-action-btn {
		width: auto;
		min-width: 52px;
		min-height: 40px;
		padding: 5px 10px;
	}

	.workspace-feed-filters {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		padding-bottom: 1px;
	}

	.workspace-action-receipt,
	.workspace-filter-receipt {
		display: inline-flex;
		min-height: 40px;
		align-items: center;
		justify-content: center;
		padding: 0 10px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 76%, transparent);
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 850;
		line-height: 1.25;
		text-align: center;
	}

	.workspace-filter-receipt {
		flex: 1 1 72px;
		min-width: 0;
		min-height: 40px;
		justify-content: space-between;
		gap: 3px;
		border-radius: 999px;
		font-size: 9px;
	}

	.workspace-filter-receipt.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 14%, transparent);
		color: var(--color-ws-blue);
	}

	.workspace-feed-filters button {
		display: flex;
		flex: 1 1 72px;
		min-width: 0;
		min-height: 40px;
		align-items: center;
		justify-content: space-between;
		gap: 3px;
		padding: 3px 5px;
		border: 1px solid var(--ws-hair);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-surface2) 76%, transparent);
		color: var(--color-ws-text);
		font-size: 9px;
		font-weight: 850;
		line-height: 1;
		cursor: pointer;
	}

	.workspace-feed-filters button:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 50%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 10%, var(--color-ws-surface2));
		color: var(--color-ws-ink);
	}

	.workspace-feed-filters button.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 72%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 18%, var(--color-ws-surface2));
		color: var(--color-ws-blue);
	}

	.workspace-feed-filters span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.workspace-feed-filters em {
		flex: 0 0 auto;
		color: inherit;
		font-style: normal;
		opacity: 0.72;
	}

	.workspace-note-input {
		width: 100%;
		min-height: 48px;
		padding: 8px 10px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-bg) 36%, var(--color-ws-surface));
		color: var(--color-ws-ink);
		resize: vertical;
	}

	.workspace-note-input::placeholder {
		color: var(--color-ws-faint);
	}

	.workspace-note-btn {
		min-height: 40px;
	}

	.workspace-feed-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding-top: 6px;
	}

	.workspace-note-drawer,
	.workspace-feed-drawer {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: var(--color-ws-surface);
		box-shadow: 0 1px 0 color-mix(in srgb, var(--color-ws-ink) 2%, transparent) inset;
	}

	.workspace-note-drawer {
		padding: 0 8px 8px;
	}

	.workspace-note-drawer summary,
	.workspace-feed-drawer-toggle {
		display: flex;
		width: 100%;
		min-height: 40px;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		border: 0;
		background: transparent;
		color: var(--color-ws-text);
		cursor: pointer;
		font-size: 10px;
		font-weight: 850;
	}

	.workspace-feed-drawer-toggle {
		padding: 0 9px;
	}

	.workspace-note-drawer summary em,
	.workspace-feed-drawer-toggle em {
		color: var(--color-ws-blue);
		font-style: normal;
		text-transform: none;
	}

	.workspace-feed-focus {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		padding: 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 22%, transparent);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-accent) 8%, var(--color-ws-surface));
		box-shadow: inset 3px 0 0 color-mix(in srgb, var(--color-ws-accent) 44%, transparent);
	}

	.workspace-feed-focus.warning {
		border-color: color-mix(in srgb, var(--color-ws-amber) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 8%, var(--color-ws-surface));
		box-shadow: inset 3px 0 0 color-mix(in srgb, var(--color-ws-amber) 54%, transparent);
	}

	.workspace-feed-focus.error {
		border-color: color-mix(in srgb, var(--color-ws-rose) 30%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 9%, var(--color-ws-surface));
		box-shadow: inset 3px 0 0 color-mix(in srgb, var(--color-ws-rose) 58%, transparent);
	}

	.workspace-feed-focus.passive {
		border-style: dashed;
		background: color-mix(in srgb, var(--color-ws-surface2) 70%, transparent);
		box-shadow: inset 3px 0 0 color-mix(in srgb, var(--color-ws-accent) 22%, transparent);
	}

	.workspace-feed-focus-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	.workspace-feed-focus-copy span {
		color: var(--color-ws-blue);
		font-size: 9px;
		font-weight: 900;
	}

	.workspace-feed-focus-copy strong {
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 850;
		line-height: 1.25;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.workspace-feed-focus-copy small {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 10px;
		line-height: 1.25;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.workspace-feed-focus > button {
		min-height: 40px;
		padding: 0 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 42%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: linear-gradient(100deg, var(--color-ws-violet), color-mix(in srgb, var(--color-ws-rose) 72%, var(--color-ws-violet)));
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 10px;
		font-weight: 850;
	}

	.workspace-feed-row {
		position: relative;
		display: flex;
		width: 100%;
		min-height: 40px;
		padding: 9px 10px 9px 12px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 72%, transparent);
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.workspace-feed-row::before {
		position: absolute;
		inset: 10px auto 10px 0;
		width: 3px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-accent) 72%, transparent);
		content: "";
	}

	.workspace-feed-row.error::before {
		background: var(--color-ws-rose);
	}

	.workspace-feed-row.warning::before {
		background: var(--color-ws-amber);
	}

	.workspace-feed-row.passive {
		cursor: default;
		border-style: dashed;
		background: color-mix(in srgb, var(--color-ws-surface2) 54%, transparent);
	}

	.workspace-feed-row.passive::before {
		background: color-mix(in srgb, var(--color-ws-accent) 28%, transparent);
	}

	.workspace-feed-row.actionable:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 55%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 12%, var(--color-ws-surface2));
	}

	.workspace-feed-row.selected {
		border-color: color-mix(in srgb, var(--color-ws-accent) 82%, transparent);
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--color-ws-accent) 24%, var(--color-ws-surface2)),
			color-mix(in srgb, var(--color-ws-accent) 12%, var(--color-ws-surface))
		);
		box-shadow:
			inset 3px 0 0 var(--color-ws-cyan),
			0 0 0 1px color-mix(in srgb, var(--color-ws-accent) 22%, transparent);
	}

	.workspace-feed-main {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 4px;
		width: 100%;
	}

	.workspace-feed-title-row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: baseline;
		gap: 7px;
		min-width: 0;
	}

	.workspace-feed-title-row > span {
		padding: 2px 5px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
		color: var(--color-ws-blue);
		font-size: 9px;
		font-weight: 850;
		line-height: 1;
	}

	.workspace-feed-row.error .workspace-feed-title-row > span {
		background: color-mix(in srgb, var(--color-ws-rose) 14%, transparent);
		color: var(--color-ws-rose);
	}

	.workspace-feed-row.warning .workspace-feed-title-row > span {
		background: color-mix(in srgb, var(--color-ws-amber) 13%, transparent);
		color: var(--color-ws-amber);
	}

	.workspace-feed-main strong {
		overflow-wrap: anywhere;
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 740;
		line-height: 1.2;
		white-space: normal;
	}

	.workspace-feed-main small {
		display: -webkit-box;
		overflow: hidden;
		font-size: 10px;
		color: var(--color-ws-text);
		line-height: 1.35;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
	}

	.workspace-feed-meta-row {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		align-items: center;
	}

	.workspace-feed-action-chip,
	.workspace-feed-page-chip,
	.workspace-feed-kind-chip {
		display: inline-flex;
		max-width: 100%;
		min-height: 18px;
		align-items: center;
		padding: 2px 6px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 24%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-accent) 8%, transparent);
		color: var(--color-ws-blue);
		font-size: 9px;
		font-weight: 850;
		line-height: 1;
	}

	.workspace-feed-page-chip {
		border-color: var(--ws-hair-strong);
		background: color-mix(in srgb, var(--color-ws-surface2) 64%, transparent);
		color: var(--color-ws-text);
	}

	.workspace-feed-kind-chip {
		border-color: var(--ws-hair-strong);
		background: color-mix(in srgb, var(--color-ws-surface2) 76%, transparent);
		color: var(--color-ws-ink);
	}

	.workspace-feed-row.passive .workspace-feed-action-chip {
		border-color: var(--ws-hair);
		color: var(--color-ws-faint);
	}

	.priority-chip {
		align-self: flex-start;
		max-width: 72px;
		padding: 1px 4px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: 999px;
		color: var(--color-ws-text);
		font-size: 9px;
		font-style: normal;
		font-weight: 850;
		line-height: 1;
	}

	.due-chip {
		align-self: flex-start;
		max-width: 112px;
		padding: 1px 4px;
		border: 1px solid color-mix(in srgb, var(--color-ws-blue) 36%, transparent);
		border-radius: 999px;
		color: var(--color-ws-blue);
		font-size: 9px;
		font-style: normal;
		font-weight: 850;
		line-height: 1;
	}

	.due-chip.overdue {
		border-color: color-mix(in srgb, var(--color-ws-rose) 58%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 15%, transparent);
		color: var(--color-ws-rose);
	}

	.due-chip.soon {
		border-color: color-mix(in srgb, var(--color-ws-amber) 46%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 11%, transparent);
		color: var(--color-ws-amber);
	}

	.priority-chip.urgent {
		border-color: color-mix(in srgb, var(--color-ws-rose) 58%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 15%, transparent);
		color: var(--color-ws-rose);
	}

	.priority-chip.high {
		border-color: color-mix(in srgb, var(--color-ws-amber) 46%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 11%, transparent);
		color: var(--color-ws-amber);
	}

	.workspace-feed-title-row time {
		color: var(--color-ws-text);
		font-size: 10px;
		text-align: right;
	}

	.workspace-feed-mentions {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding-top: 2px;
	}

	.workspace-feed-mentions em {
		padding: 1px 4px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 38%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-amber) 10%, transparent);
		color: var(--color-ws-amber);
		font-size: 10px;
		font-style: normal;
		font-weight: 700;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 12px;
		border: 1px dashed var(--ws-hair-strong);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
		color: var(--color-ws-text);
		font-size: 11px;
	}

	.empty-state strong {
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 850;
	}

	@media (min-width: 861px) and (max-width: 1040px) {
		.layer-action-btn,
		.workspace-feed-filters button,
		.workspace-note-drawer summary,
		.workspace-feed-drawer-toggle,
		.workspace-feed-focus > button,
		.workspace-feed-row {
			min-height: 40px;
		}

		.workspace-hub-summary .layer-action-btn {
			min-height: 40px;
			padding: 0 12px;
		}

		.workspace-note-input {
			min-height: 64px;
			font-size: 12px;
		}
	}
</style>
