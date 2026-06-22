<script lang="ts">
	import { _ } from "$lib/i18n";
	import type { WorkspaceHrefInput } from "$lib/navigation/workspace-routes.js";

	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	interface BreadcrumbItem {
		label: string;
		target?: WorkspaceHrefInput;
		current?: boolean;
	}

	let {
		items,
		onOpen,
	}: {
		items: BreadcrumbItem[];
		onOpen: (target: WorkspaceHrefInput) => void;
	} = $props();
</script>

{#if items.length > 0}
	<nav class="workspace-breadcrumb" aria-label={t("topbar.breadcrumbAria", "Workspace path")}>
		{#each items as item, index (`breadcrumb-${index}-${item.label}`)}
			{#if item.target && !item.current}
				<button type="button" onclick={() => item.target && onOpen(item.target)}>{item.label}</button>
			{:else}
				<strong>{item.label}</strong>
			{/if}
			{#if index < items.length - 1}
				<span aria-hidden="true">/</span>
			{/if}
		{/each}
	</nav>
{/if}

<style>
	.workspace-breadcrumb {
		display: flex;
		align-items: center;
		min-width: 0;
		gap: 8px;
		color: var(--color-ws-text, #9a9aa8);
		font-size: 13px;
		font-weight: 500;
		line-height: 1.2;
	}

	.workspace-breadcrumb button,
	.workspace-breadcrumb strong {
		min-width: 0;
		/* Desktop has plenty of room: give each crumb a generous cap so full
		   story/chapter titles show, and only ellipsize (cleanly, never mid-word —
		   text-overflow:ellipsis cuts at the glyph boundary) on genuinely long ones.
		   The clamp keeps it sane on narrow viewports where space is tight. */
		max-width: clamp(180px, 32vw, 460px);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The current (last) crumb is the page you're on — give it the most room so the
	   active story/chapter title reads in full on desktop. */
	.workspace-breadcrumb strong {
		max-width: clamp(200px, 44vw, 620px);
	}

	.workspace-breadcrumb button {
		min-height: 40px;
		border: 0;
		background: transparent;
		color: var(--color-ws-text, #9a9aa8);
		cursor: pointer;
		font: inherit;
		padding: 0;
		transition: color 0.14s ease;
	}

	.workspace-breadcrumb button:hover {
		color: var(--color-ws-ink, #ececf2);
	}

	.workspace-breadcrumb strong {
		color: var(--color-ws-ink, #ececf2);
		font-weight: 600;
	}

	.workspace-breadcrumb span {
		color: var(--color-ws-faint, #6b6b78);
	}
</style>
