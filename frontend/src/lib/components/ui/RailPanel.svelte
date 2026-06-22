<script lang="ts">
	import type { Snippet } from "svelte";

	let {
		title,
		subtitle = "",
		class: klass = "",
		children,
	}: {
		title: string;
		subtitle?: string;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<div class={`rounded-ws border border-ws-line/15 bg-ws-surface/80 p-4 ${klass}`}>
	{#if title || subtitle}
		<div class="mb-3">
			{#if title}
				<h3 class="truncate text-[12px] font-bold text-ws-ink">{title}</h3>
			{/if}
			{#if subtitle}
				<p class="truncate text-[10.5px] text-ws-text">{subtitle}</p>
			{/if}
		</div>
	{/if}
	{@render children()}
</div>
