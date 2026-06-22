<!-- PanelSection - collapsible section header + content. ws-token styled.
	Uses native <details> so it works without JS state plumbing, but caller can
	control via `open` + `onToggle` for managed mode. -->
<script lang="ts">
	import type { Snippet } from "svelte";

	let {
		title,
		eyebrow = "",
		summary = "",
		open = true,
		collapsible = true,
		padded = true,
		onToggle,
		class: klass = "",
		bodyClass = "",
		header,
		children,
		action,
	}: {
		title: string;
		eyebrow?: string;
		summary?: string;
		open?: boolean;
		collapsible?: boolean;
		padded?: boolean;
		onToggle?: (open: boolean) => void;
		class?: string;
		bodyClass?: string;
		header?: Snippet;
		children: Snippet;
		action?: Snippet;
	} = $props();

	function handleToggle(event: Event): void {
		if (!onToggle) return;
		const target = event.currentTarget as HTMLDetailsElement;
		onToggle(target.open);
	}
</script>

{#if collapsible}
	<details
		class={`ws-panel rounded-ws-card ${klass}`}
		{open}
		ontoggle={handleToggle}
	>
		<summary class="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 outline-none [&::-webkit-details-marker]:hidden">
			<div class="min-w-0 flex-1">
				{#if header}
					{@render header()}
				{:else}
					{#if eyebrow}
						<span class="block text-[10px] font-black uppercase tracking-wider text-ws-accent">{eyebrow}</span>
					{/if}
					<span class="block truncate text-[12px] font-bold text-ws-ink">{title}</span>
					{#if summary}<span class="block truncate text-[11px] text-ws-text">{summary}</span>{/if}
				{/if}
			</div>
			<div class="flex items-center gap-2">
				{#if action}{@render action()}{/if}
				<svg
					class="h-3.5 w-3.5 shrink-0 text-ws-faint transition-transform duration-150 [details[open]_&]:rotate-90"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.5"
					aria-hidden="true"
				>
					<path d="m9 6 6 6-6 6" />
				</svg>
			</div>
		</summary>
		<div class={`${padded ? "px-3 pb-3" : ""} ${bodyClass}`}>
			{@render children()}
		</div>
	</details>
{:else}
	<section class={`ws-panel rounded-ws-card ${klass}`}>
		<header class="flex items-center justify-between gap-2 px-3 py-2">
			<div class="min-w-0 flex-1">
				{#if header}
					{@render header()}
				{:else}
					{#if eyebrow}
						<span class="block text-[10px] font-black uppercase tracking-wider text-ws-accent">{eyebrow}</span>
					{/if}
					<span class="block truncate text-[12px] font-bold text-ws-ink">{title}</span>
					{#if summary}<span class="block truncate text-[11px] text-ws-text">{summary}</span>{/if}
				{/if}
			</div>
			{#if action}{@render action()}{/if}
		</header>
		<div class={`${padded ? "px-3 pb-3" : ""} ${bodyClass}`}>
			{@render children()}
		</div>
	</section>
{/if}
