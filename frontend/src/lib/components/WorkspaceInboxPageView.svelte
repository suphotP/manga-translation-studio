<!-- WorkspaceInboxPageView - full workspace attention surface backed by the
	workspace-home aggregate. The dashboard keeps only a short rail; this page keeps
	the same open-project-first behavior for cross-project attention rows. -->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import { queueWorkspaceHrefNavigation } from "$lib/navigation/workspace-navigation.js";
	import { hrefForWorkspaceView } from "$lib/navigation/workspace-routes.js";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { workspaceHomeStore } from "$lib/stores/workspace-home.svelte.ts";
	import type { WorkspaceHomeFeedItem } from "$lib/api/client.js";
	import type { WorkspaceFeedItem } from "$lib/types.js";
	import AttentionRow, { type AttentionTone } from "$lib/components/ui/AttentionRow.svelte";
	import NumberValue from "$lib/components/ui/NumberValue.svelte";
	import WorkspacePageHeader from "$lib/components/ui/WorkspacePageHeader.svelte";
	import WorkspaceTopUtilityBar from "$lib/components/WorkspaceTopUtilityBar.svelte";

	type InboxFilter = "all" | "urgent";

	let activeFilter = $state<InboxFilter>("all");
	let retryBusy = $state(false);

	let isActive = $derived(editorUiStore.workspaceView === "inbox");
	let homeLoaded = $derived(workspaceHomeStore.hasLoaded);
	let homeLoading = $derived(workspaceHomeStore.loading && !homeLoaded);
	let homeError = $derived(!homeLoaded && !workspaceHomeStore.loading ? workspaceHomeStore.error : null);
	let urgentAttention = $derived(workspaceHomeStore.attention.filter(isHotAttentionItem));
	let sourceItems = $derived(activeFilter === "urgent" ? urgentAttention : workspaceHomeStore.attention);
	let atServerCap = $derived(workspaceHomeStore.attention.length >= 40);
	let filterOptions = $derived([
		{ id: "all" as const, label: $_("inboxPage.filterAll"), count: workspaceHomeStore.attention.length },
		{ id: "urgent" as const, label: $_("inboxPage.filterUrgent"), count: urgentAttention.length },
	]);

	function isHotAttentionItem(item: WorkspaceHomeFeedItem): boolean {
		return item.severity === "error" || item.dueState === "overdue" || item.priority === "urgent";
	}

	function feedAttentionRowTone(item: WorkspaceFeedItem): AttentionTone {
		if (item.severity === "error" || item.dueState === "overdue" || item.priority === "urgent") return "urgent";
		if (item.kind === "ai_marker") return "ai";
		if (item.kind === "comment" || item.kind === "message") return "mention";
		if (item.kind === "task" || item.kind === "review_decision" || item.kind === "version_review" || item.severity === "warning") return "review";
		return "ai";
	}

	function kindLabel(kind: WorkspaceFeedItem["kind"]): string {
		return $_(`inboxPage.kind.${kind}`);
	}

	function priorityLabel(priority: WorkspaceFeedItem["priority"]): string {
		if (priority === "urgent") return $_("inboxPage.priorityUrgent");
		if (priority === "high") return $_("inboxPage.priorityHigh");
		return $_("inboxPage.priorityNormal");
	}

	function statusLabel(status: string | undefined): string {
		if (status === "todo") return $_("inboxPage.statusTodo");
		if (status === "doing") return $_("inboxPage.statusDoing");
		if (status === "review") return $_("inboxPage.statusReview");
		if (status === "done") return $_("inboxPage.statusDone");
		return status ?? "";
	}

	function dueLabel(item: WorkspaceFeedItem): string {
		if (!item.dueAt) return "";
		const date = item.dueAt.slice(0, 10);
		if (item.dueState === "overdue") return `${$_("inboxPage.dueOverdue")} ${date}`;
		if (item.dueState === "soon") return `${$_("inboxPage.dueSoon")} ${date}`;
		return `${$_("inboxPage.due")} ${date}`;
	}

	function titleLabel(item: WorkspaceFeedItem): string {
		if (item.kind === "message") return $_("inboxPage.titleHandoffNote");
		if (item.kind === "comment") return $_("inboxPage.titleOpenComment");
		if (item.kind === "review_decision") {
			return item.status === "approved" ? $_("inboxPage.titlePageApproved") : $_("inboxPage.titleChangesRequested");
		}
		if (item.kind === "version_review") {
			if (item.status === "approved") return $_("inboxPage.titleVersionApproved");
			if (item.status === "changes_requested") return $_("inboxPage.titleVersionChangesRequested");
			return $_("inboxPage.titleVersionReviewRequested");
		}
		if (item.kind === "ai_marker") {
			const tier = item.title.replace(/^AI\s+/i, "").trim() || item.title;
			return $_("inboxPage.titleAiReview", { values: { tier } });
		}
		if (item.kind === "export_run") {
			return item.status === "error" ? $_("inboxPage.titleExportFailed") : $_("inboxPage.titleExportCompleted");
		}
		return item.title;
	}

	function detailLabel(item: WorkspaceFeedItem): string {
		if (item.kind !== "task") return item.detail;
		const parts = [priorityLabel(item.priority), statusLabel(item.status)];
		const actor = item.actor?.trim();
		if (actor) parts.push(actor.startsWith("@") ? actor : `@${actor}`);
		const due = dueLabel(item);
		if (due) parts.push(due);
		return parts.filter(Boolean).join(" / ");
	}

	function rowMeta(item: WorkspaceHomeFeedItem): string {
		return [item.projectName, detailLabel(item)].filter(Boolean).join(" · ");
	}

	async function retryWorkspaceHome(): Promise<void> {
		if (retryBusy) return;
		retryBusy = true;
		try {
			await workspaceHomeStore.load(workspaceHomeStore.currentWorkspaceId);
		} finally {
			retryBusy = false;
		}
	}

	async function openAttentionItem(item: WorkspaceHomeFeedItem): Promise<void> {
		// Cross-project attention rows must open their owning project first so the
		// Work board never lands on the previously open chapter.
		if (projectStore.project?.projectId !== item.projectId) {
			const opened = await projectStore.openProject(item.projectId, editorStore.editor);
			if (opened === false) return;
		}
		editorUiStore.openWorkBoard();
		queueWorkspaceHrefNavigation(hrefForWorkspaceView("work", item.projectId));
	}
</script>

{#if isActive}
	<section class="ws-surface workspace-inbox-shell" aria-label={$_("inboxPage.surfaceAria")} data-testid="inbox-page">
		<div class="ws-surface-inner">
			<WorkspaceTopUtilityBar />
			<WorkspacePageHeader
				eyebrow={$_("inboxPage.eyebrow")}
				title={$_("inboxPage.title")}
				subtitle={$_("inboxPage.subtitle")}
			>
				{#snippet actions()}
					<span class="inbox-count-badge ws-grad-primary-soft">
						<NumberValue value={sourceItems.length} /> {$_("inboxPage.itemsUnit")}
					</span>
				{/snippet}
			</WorkspacePageHeader>

			<div class="inbox-toolbar ws-panel rounded-ws-card" data-testid="inbox-page-toolbar">
				<div class="inbox-filter-row" aria-label={$_("inboxPage.filtersAria")}>
					{#each filterOptions as option (option.id)}
						<button
							type="button"
							class="inbox-filter-chip"
							class:active={activeFilter === option.id}
							aria-pressed={activeFilter === option.id}
							onclick={() => activeFilter = option.id}
						>
							<span>{option.label}</span>
							<small><NumberValue value={option.count} /></small>
						</button>
					{/each}
				</div>
			</div>

			{#if homeLoading}
				<div class="inbox-state ws-panel rounded-ws-card" data-testid="inbox-page-loading">
					<p>{$_("inboxPage.loading")}</p>
				</div>
			{:else if homeError}
				<div class="inbox-state ws-panel rounded-ws-card" data-testid="inbox-page-error" role="alert">
					<p>{$_("inboxPage.errorTitle")}</p>
					<small>{homeError}</small>
					{#if retryBusy}
						<span class="inbox-retry-receipt">{$_("inboxPage.retrying")}</span>
					{:else}
						<button type="button" class="ws-btn-ghost rounded-ws-ctrl" onclick={() => void retryWorkspaceHome()}>{$_("inboxPage.retry")}</button>
					{/if}
				</div>
			{:else if workspaceHomeStore.attention.length === 0}
				<div class="inbox-state ws-panel rounded-ws-card" data-testid="inbox-page-empty">
					<p>{$_("inboxPage.emptyTitle")}</p>
					<small>{$_("inboxPage.emptyDetail")}</small>
				</div>
			{:else if sourceItems.length === 0}
				<div class="inbox-state ws-panel rounded-ws-card" data-testid="inbox-page-no-results">
					<p>{$_("inboxPage.noUrgentTitle")}</p>
					<small>{$_("inboxPage.noUrgentDetail")}</small>
				</div>
			{:else}
				<div class="inbox-list" data-testid="inbox-page-list">
					{#each sourceItems as item (item.id)}
						<div class="inbox-row ws-panel" data-testid="inbox-page-row">
							<AttentionRow
								tone={feedAttentionRowTone(item)}
								text={titleLabel(item)}
								meta={rowMeta(item)}
								badge={kindLabel(item.kind)}
								onclick={() => { void openAttentionItem(item); }}
								class="inbox-attention-row"
							/>
						</div>
					{/each}
				</div>
			{/if}
		</div>
		{#if atServerCap}
			<p class="text-[11.5px] text-ws-faint px-1 pb-2">{$_("inboxPage.serverCapNote")}</p>
		{/if}
	</section>
{/if}

<style>
	.workspace-inbox-shell {
		color: var(--color-ws-text);
	}

	.inbox-count-badge {
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

	.inbox-toolbar {
		margin-bottom: 16px;
		padding: 14px;
	}

	.inbox-filter-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.inbox-filter-chip {
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

	.inbox-filter-chip small {
		color: var(--color-ws-faint);
		font-size: 11px;
		font-weight: 800;
	}

	.inbox-filter-chip.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 56%, var(--color-ws-line));
		background: color-mix(in srgb, var(--color-ws-accent) 15%, var(--color-ws-surface));
		color: var(--color-ws-ink);
	}

	.inbox-list {
		display: grid;
		gap: 10px;
	}

	.inbox-row {
		overflow: hidden;
		border-radius: var(--radius-ws-card);
		padding: 5px;
	}

	:global(.inbox-attention-row) {
		min-height: 64px;
		padding: 12px;
	}

	.inbox-state {
		display: grid;
		min-height: 180px;
		place-items: center;
		align-content: center;
		gap: 8px;
		padding: 28px;
		text-align: center;
	}

	.inbox-state p {
		margin: 0;
		color: var(--color-ws-ink);
		font-size: 15px;
		font-weight: 900;
	}

	.inbox-state small {
		max-width: 520px;
		color: var(--color-ws-faint);
		font-size: 12px;
		line-height: 1.5;
	}

	.inbox-retry-receipt {
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
</style>
