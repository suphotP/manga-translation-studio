<script lang="ts">
	import { _ } from "$lib/i18n";
	import type { TaskFocusItem } from "$lib/project/task-focus-queue.js";
	import type { WorkInboxItem } from "$lib/project/work-inbox.js";

	interface PageStateRoleNextWork {
		pageIndex: number;
		roleId: string;
		title: string;
		detail: string;
		action: string;
	}

	interface Props {
		hasProject: boolean;
		selectedRoleNextItem: TaskFocusItem | null;
		selectedRolePageStateNext: PageStateRoleNextWork | null;
		roleNextHeading: string;
		roleNextPrimaryAction: string;
		roleNextCanvasAction: string;
		workItemDisplayTitle: (item: TaskFocusItem | WorkInboxItem | null) => string;
		roleNextDetail: (item: TaskFocusItem | null) => string;
		onFocusSelectedRoleNext: () => void;
		onOpenSelectedRoleNextInEditor: () => void;
		onCopyFocusLink: (item: TaskFocusItem | WorkInboxItem | null) => void;
		onOpenSelectedRolePageStateNext: () => void;
		onOpenCanvas: () => void;
	}

	let {
		hasProject,
		selectedRoleNextItem,
		selectedRolePageStateNext,
		roleNextHeading,
		roleNextPrimaryAction,
		roleNextCanvasAction,
		workItemDisplayTitle,
		roleNextDetail,
		onFocusSelectedRoleNext,
		onOpenSelectedRoleNextInEditor,
		onCopyFocusLink,
		onOpenSelectedRolePageStateNext,
		onOpenCanvas,
	}: Props = $props();
</script>

<section class={`role-next-strip ws-panel ${selectedRoleNextItem || selectedRolePageStateNext ? "active" : "idle"}`} aria-label={$_("workBoard.roleNextAria")}>
	<div class="role-next-copy">
		<span>{roleNextHeading}</span>
		<strong>{selectedRoleNextItem ? workItemDisplayTitle(selectedRoleNextItem) : (selectedRolePageStateNext?.title ?? $_("workBoard.queueClear"))}</strong>
		<small>{selectedRoleNextItem ? roleNextDetail(selectedRoleNextItem) : (selectedRolePageStateNext?.detail ?? roleNextDetail(null))}</small>
	</div>
	<div class="role-next-actions">
		{#if selectedRoleNextItem}
			<button type="button" class="primary ws-grad-primary" onclick={onFocusSelectedRoleNext}>
				{roleNextPrimaryAction}
			</button>
			<details class="work-row-more">
				<summary class="ws-btn-ghost">{$_("workBoard.more")}</summary>
				<div class="work-row-more-menu">
					<button type="button" class="ws-btn-ghost" onclick={onOpenSelectedRoleNextInEditor}>
						{roleNextCanvasAction}
					</button>
					<button type="button" class="ws-btn-ghost" onclick={() => onCopyFocusLink(selectedRoleNextItem)}>
						{$_("workBoard.copyLink")}
					</button>
				</div>
			</details>
		{:else if selectedRolePageStateNext}
			<button type="button" class="primary ws-grad-primary" onclick={onOpenSelectedRolePageStateNext}>
				{selectedRolePageStateNext.action}
			</button>
		{:else if hasProject}
			<button type="button" class="primary ws-grad-primary" onclick={onOpenCanvas}>
				{$_("workBoard.viewPage")}
			</button>
		{:else}
			<span class="action-receipt ready ws-grad-primary-soft">{$_("workBoard.noModeQueue")}</span>
		{/if}
	</div>
</section>

<style>
	.role-next-strip {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface) 86%, transparent);
		color: var(--color-ws-ink);
	}

	.role-next-strip.active {
		border-color: color-mix(in srgb, var(--color-ws-green) 32%, transparent);
		background:
			linear-gradient(
				90deg,
				color-mix(in srgb, var(--color-ws-green) 14%, transparent),
				color-mix(in srgb, var(--color-ws-accent) 8%, transparent)
			),
			color-mix(in srgb, var(--color-ws-surface) 84%, transparent);
	}

	.role-next-strip.idle {
		border-color: var(--ws-hair);
		background: color-mix(in srgb, var(--color-ws-surface2) 62%, transparent);
	}

	.role-next-copy span {
		color: var(--color-ws-violet);
	}

	.role-next-copy strong {
		color: var(--color-ws-ink);
	}

	.role-next-copy small {
		color: var(--color-ws-text);
	}

	.role-next-actions button,
	.work-row-more summary,
	.work-row-more-menu button {
		min-height: 38px;
		border-radius: var(--radius-ws-ctrl);
		border: 1px solid var(--ws-hair);
		color: var(--color-ws-ink);
		font-family: inherit;
	}

	.role-next-actions > button.primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 52%, transparent);
	}

	.work-row-more[open] summary,
	.work-row-more-menu {
		border-color: color-mix(in srgb, var(--color-ws-accent) 35%, transparent);
		background: var(--color-ws-surface);
	}

	.action-receipt.ready {
		border: 1px solid color-mix(in srgb, var(--color-ws-green) 30%, transparent);
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-ink);
	}
</style>
