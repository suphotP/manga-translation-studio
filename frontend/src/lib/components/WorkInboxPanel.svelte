<script lang="ts">
	import { _ } from "$lib/i18n";
	import { formatAssigneeHandle } from "$lib/project/assignees.js";
	import type { WorkInboxItem } from "$lib/project/work-inbox.js";
	import { workInboxTitle, workInboxDetail } from "$lib/project/work-inbox-copy.js";
	import { formatWorkflowDueDay } from "$lib/project/task-due.js";
	import ScopeToggle from "./ScopeToggle.svelte";

	type WorkInboxScope = "page" | "all";

	interface Props {
		totalCount: number;
		pageCount: number;
		projectOpen: boolean;
		items: WorkInboxItem[];
		scope: WorkInboxScope;
		selectedItemId: string | null;
		severityLabel: (severity: WorkInboxItem["severity"]) => string;
		onScopeChange: (scope: WorkInboxScope) => void;
		onOpenItem: (item: WorkInboxItem) => void;
	}

	let {
		totalCount,
		pageCount,
		projectOpen,
		items,
		scope,
		selectedItemId,
		severityLabel,
		onScopeChange,
		onOpenItem,
	}: Props = $props();

	let focusedItem = $derived(
		items.find((item) => item.id === selectedItemId) ?? items[0] ?? null
	);
	let visibleItems = $derived(getVisibleItems());
	let hiddenItemCount = $derived(Math.max(0, items.length - visibleItems.length));
	let showInboxList = $state(false);

	function getVisibleItems(): WorkInboxItem[] {
		if (!focusedItem) return items.slice(0, 6);
		const firstSix = items.slice(0, 6);
		if (firstSix.some((item) => item.id === focusedItem.id)) return firstSix;
		return [focusedItem, ...firstSix.slice(0, 5)];
	}

	function priorityLabel(value: WorkInboxItem["priority"]): string {
		if (value === "urgent") return $_("workInboxPanel.priority.urgent");
		if (value === "high") return $_("workInboxPanel.priority.high");
		return $_("workInboxPanel.priority.normal");
	}

	function statusLabel(value: WorkInboxItem["status"]): string {
		if (value === "done") return $_("workInboxPanel.status.done");
		if (value === "review") return $_("workInboxPanel.status.review");
		if (value === "doing") return $_("workInboxPanel.status.doing");
		if (value === "todo") return $_("workInboxPanel.status.todo");
		return value ?? "";
	}

	// Localized title/detail composed from the inbox item's structured fields
	// (replaces the formerly-composed Thai `item.title` / `item.detail`).
	function itemTitle(item: WorkInboxItem): string {
		return workInboxTitle(item, $_);
	}

	function itemDetail(item: WorkInboxItem): string {
		return workInboxDetail(item.detail, $_);
	}
</script>

	<div class="inbox-panel">
		<div class="inbox-summary">
			<span>{$_("workInboxPanel.openCount", { values: { n: totalCount } })}</span>
			<span>{$_("workInboxPanel.onThisPage", { values: { n: pageCount } })}</span>
		</div>
		<ScopeToggle label={$_("workInboxPanel.scopeLabel")} value={scope} onChange={onScopeChange} />

	{#if !projectOpen}
		<div class="empty-state">
			<strong>{$_("workInboxPanel.openWork")}</strong>
			<span>{$_("workInboxPanel.openWorkHint")}</span>
		</div>
	{:else if items.length === 0}
		<div class="empty-state">
			<strong>{scope === "all" ? $_("workInboxPanel.emptyAllTitle") : $_("workInboxPanel.emptyPageTitle")}</strong>
			<span>{scope === "all" ? $_("workInboxPanel.emptyAllHint") : $_("workInboxPanel.emptyPageHint")}</span>
		</div>
	{:else}
		{#if focusedItem}
			<button
				type="button"
				class={`inbox-focus-card ${focusedItem.severity}`}
				onclick={() => onOpenItem(focusedItem)}
				aria-label={$_("workInboxPanel.openItemAria", { values: { title: itemTitle(focusedItem) } })}
			>
				<div class="inbox-focus-copy">
					<span>{$_("workInboxPanel.nextWork")}</span>
					<strong>{itemTitle(focusedItem)}</strong>
					<small>{itemDetail(focusedItem)}</small>
					<div class="inbox-meta inbox-focus-meta">
						<em class={`severity-chip ${focusedItem.severity}`}>{severityLabel(focusedItem.severity)}</em>
					</div>
					{#if (focusedItem.priority && focusedItem.priority !== "normal") || focusedItem.status || focusedItem.assignee || focusedItem.dueAt}
						<div class="inbox-meta inbox-focus-meta">
							{#if focusedItem.priority && focusedItem.priority !== "normal"}
								<em class={`priority-chip ${focusedItem.priority}`}>{priorityLabel(focusedItem.priority)}</em>
							{/if}
								{#if focusedItem.dueAt}
									<em class:overdue={focusedItem.overdue} class="due-chip">
										{focusedItem.overdue ? $_("workInboxPanel.due.overdue") : $_("workInboxPanel.due.due")} {formatWorkflowDueDay(focusedItem.dueAt)}
									</em>
								{/if}
							{#if focusedItem.status}
								<em class={`status-chip ${focusedItem.status}`}>{statusLabel(focusedItem.status)}</em>
							{/if}
							{#if focusedItem.assignee}
								<em class="assignee-chip">{formatAssigneeHandle(focusedItem.assignee)}</em>
							{/if}
						</div>
					{/if}
				</div>
					<span class="inbox-focus-action">{$_("workInboxPanel.open")}</span>
			</button>
		{/if}

		<div class="inbox-drawer">
			<button
				type="button"
				class="inbox-drawer-toggle"
				aria-expanded={showInboxList}
				onclick={() => showInboxList = !showInboxList}
			>
					<span>{$_("workInboxPanel.listTitle")}</span>
					<em>{items.length}{hiddenItemCount ? ` / ${$_("workInboxPanel.hidden", { values: { n: hiddenItemCount } })}` : ""}</em>
			</button>
			{#if showInboxList}
				<div class="inbox-list">
					{#each visibleItems as item (item.id)}
						<button
							type="button"
							class={`inbox-row ${item.severity}`}
							class:selected={selectedItemId === item.id}
							onclick={() => onOpenItem(item)}
						>
							<div class="inbox-main">
								<div class="inbox-title-row">
									<span>{severityLabel(item.severity)}</span>
									<strong>{itemTitle(item)}</strong>
								</div>
								<small>{itemDetail(item)}</small>
								{#if (item.priority && item.priority !== "normal") || item.status || item.assignee || item.dueAt}
										<div class="inbox-meta">
										{#if item.priority && item.priority !== "normal"}
											<em class={`priority-chip ${item.priority}`}>{priorityLabel(item.priority)}</em>
										{/if}
											{#if item.dueAt}
												<em class:overdue={item.overdue} class="due-chip">
													{item.overdue ? $_("workInboxPanel.due.overdue") : $_("workInboxPanel.due.due")} {formatWorkflowDueDay(item.dueAt)}
												</em>
											{/if}
										{#if item.status}
											<em class={`status-chip ${item.status}`}>{statusLabel(item.status)}</em>
										{/if}
										{#if item.assignee}
											<em class="assignee-chip">{formatAssigneeHandle(item.assignee)}</em>
										{/if}
									</div>
								{/if}
							</div>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.inbox-panel {
		display: flex;
		flex-direction: column;
		gap: 10px;
		color: var(--color-ws-ink);
	}

	.inbox-summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 720;
	}

	.inbox-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding-top: 6px;
	}

	.inbox-focus-card {
		position: relative;
		display: grid;
		width: 100%;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		padding: 10px 10px 10px 13px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 22%, transparent);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-accent) 8%, var(--color-ws-surface));
		box-shadow:
			inset 3px 0 0 color-mix(in srgb, var(--color-ws-accent) 46%, transparent),
			0 1px 0 color-mix(in srgb, var(--color-ws-ink) 2%, transparent) inset;
		color: inherit;
		cursor: pointer;
		text-align: left;
	}

	.inbox-focus-card.error {
		border-color: color-mix(in srgb, var(--color-ws-rose) 30%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 9%, var(--color-ws-surface));
		box-shadow:
			inset 3px 0 0 color-mix(in srgb, var(--color-ws-rose) 58%, transparent),
			0 1px 0 color-mix(in srgb, var(--color-ws-ink) 2%, transparent) inset;
	}

	.inbox-focus-card.warning {
		border-color: color-mix(in srgb, var(--color-ws-amber) 28%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 8%, var(--color-ws-surface));
		box-shadow:
			inset 3px 0 0 color-mix(in srgb, var(--color-ws-amber) 54%, transparent),
			0 1px 0 color-mix(in srgb, var(--color-ws-ink) 2%, transparent) inset;
	}

	.inbox-focus-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	.inbox-focus-copy span {
		color: var(--color-ws-blue);
		font-size: 9px;
		font-weight: 900;
		text-transform: uppercase;
	}

	.inbox-focus-copy strong {
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 850;
		line-height: 1.25;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.inbox-focus-copy small {
		display: -webkit-box;
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 10px;
		line-height: 1.25;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
	}

	.inbox-focus-action {
		display: inline-flex;
		min-height: 40px;
		align-items: center;
		padding: 0 10px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 42%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: linear-gradient(100deg, var(--color-ws-violet), color-mix(in srgb, var(--color-ws-rose) 72%, var(--color-ws-violet)));
		color: var(--color-ws-ink);
		font-size: 10px;
		font-weight: 850;
	}

	.inbox-drawer {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: var(--color-ws-surface);
		box-shadow: 0 1px 0 color-mix(in srgb, var(--color-ws-ink) 2%, transparent) inset;
	}

	.inbox-drawer-toggle {
		display: flex;
		width: 100%;
		min-height: 40px;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 0 9px;
		border: 0;
		background: transparent;
		color: var(--color-ws-text);
		cursor: pointer;
		font-size: 10px;
		font-weight: 850;
		text-transform: uppercase;
	}

	.inbox-drawer-toggle em {
		color: var(--color-ws-blue);
		font-style: normal;
	}

	.inbox-row {
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

	.inbox-row::before {
		position: absolute;
		inset: 10px auto 10px 0;
		width: 3px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-accent) 72%, transparent);
		content: "";
	}

	.inbox-row:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 55%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 12%, var(--color-ws-surface2));
	}

	.inbox-row.selected {
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

	.inbox-row.error::before {
		background: var(--color-ws-rose);
	}

	.inbox-row.warning::before {
		background: var(--color-ws-amber);
	}

	.inbox-title-row {
		display: flex;
		min-width: 0;
		align-items: baseline;
		gap: 7px;
	}

	.inbox-title-row > span {
		flex: 0 0 auto;
		padding: 2px 5px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
		color: var(--color-ws-blue);
		font-size: 9px;
		font-weight: 850;
		line-height: 1;
		text-transform: uppercase;
	}

	.inbox-row.error .inbox-title-row > span {
		background: color-mix(in srgb, var(--color-ws-rose) 14%, transparent);
		color: var(--color-ws-rose);
	}

	.inbox-row.warning .inbox-title-row > span {
		background: color-mix(in srgb, var(--color-ws-amber) 13%, transparent);
		color: var(--color-ws-amber);
	}

	.inbox-main {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.inbox-main strong,
	.inbox-main small {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.inbox-main strong {
		min-width: 0;
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 740;
		white-space: nowrap;
	}

	.inbox-main small {
		color: var(--color-ws-text);
		display: -webkit-box;
		font-size: 11px;
		line-height: 1.35;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
	}

	.inbox-meta {
		display: flex;
		min-width: 0;
		flex-wrap: wrap;
		gap: 3px;
	}

	.inbox-focus-meta {
		padding-top: 2px;
	}

	.priority-chip,
	.status-chip,
	.due-chip,
	.assignee-chip,
	.severity-chip {
		align-self: flex-start;
		max-width: 72px;
		padding: 2px 5px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: 999px;
		color: var(--color-ws-text);
		font-size: 9px;
		font-style: normal;
		font-weight: 850;
		line-height: 1;
		text-transform: uppercase;
	}

	.assignee-chip {
		max-width: 96px;
		text-transform: none;
		color: var(--color-ws-ink);
	}

	.severity-chip {
		max-width: 96px;
		border-color: color-mix(in srgb, var(--color-ws-accent) 30%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 10%, transparent);
		color: var(--color-ws-blue);
	}

	.severity-chip.error {
		border-color: color-mix(in srgb, var(--color-ws-rose) 46%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 12%, transparent);
		color: var(--color-ws-rose);
	}

	.severity-chip.warning {
		border-color: color-mix(in srgb, var(--color-ws-amber) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 10%, transparent);
		color: var(--color-ws-amber);
	}

	.due-chip {
		max-width: 112px;
		border-color: color-mix(in srgb, var(--color-ws-blue) 36%, transparent);
		color: var(--color-ws-blue);
	}

	.due-chip.overdue {
		border-color: color-mix(in srgb, var(--color-ws-rose) 58%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 15%, transparent);
		color: var(--color-ws-rose);
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

	.status-chip.doing {
		border-color: color-mix(in srgb, var(--color-ws-accent) 38%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 9%, transparent);
		color: var(--color-ws-blue);
	}

	.status-chip.review {
		border-color: color-mix(in srgb, var(--color-ws-amber) 38%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 9%, transparent);
		color: var(--color-ws-amber);
	}

	.status-chip.done {
		border-color: color-mix(in srgb, var(--color-ws-green) 38%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 9%, transparent);
		color: var(--color-ws-green);
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
		.inbox-focus-card,
		.inbox-focus-action,
		.inbox-drawer-toggle,
		.inbox-row {
			min-height: 40px;
		}
	}
</style>
