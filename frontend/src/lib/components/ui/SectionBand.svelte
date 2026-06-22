<!-- SectionBand - band header + gradient rule divider, matching the dashboard's
	PRODUCTION PIPELINE / WORK & ATTENTION bands. An eyebrow-style title, an optional
	subtitle appended after a middot, a flexible gradient rule, and an `action` slot. -->
<script lang="ts">
	import type { Snippet } from "svelte";

	let {
		title,
		subtitle = "",
		action,
		class: klass = "",
	}: {
		title: string;
		subtitle?: string;
		action?: Snippet;
		class?: string;
	} = $props();
</script>

<div class={`flex items-center gap-3 ${klass}`}>
	<h3 class="shrink-0 whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.14em] text-ws-faint">
		{title}{#if subtitle}<span class="normal-case tracking-normal"> · {subtitle}</span>{/if}
	</h3>
	<span class="h-px min-w-6 flex-1" style="background:linear-gradient(90deg, rgba(124,92,255,0.3), transparent)"></span>
	{#if action}<span class="shrink-0">{@render action()}</span>{/if}
</div>
