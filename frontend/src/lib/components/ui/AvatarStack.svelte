<!-- AvatarStack - overlapping avatar row with an optional +N overflow chip. -->
<script lang="ts">
	import Avatar, { type AvatarSize, type AvatarTone } from "./Avatar.svelte";

	export interface AvatarStackItem {
		name?: string;
		initial?: string;
		src?: string;
		tone?: AvatarTone;
	}

	let {
		items = [],
		max = 5,
		size = "sm",
		extra = 0,
		ariaLabel = "",
		class: klass = "",
	}: {
		items?: AvatarStackItem[];
		max?: number;
		size?: AvatarSize;
		extra?: number;
		ariaLabel?: string;
		class?: string;
	} = $props();

	const tones: AvatarTone[] = ["violet", "cyan", "green", "amber", "rose", "blue"];
	const extraSize: Record<AvatarSize, string> = {
		xs: "w-5 h-5 text-[8px]",
		sm: "w-6 h-6 text-[9px]",
		md: "w-8 h-8 text-[10px]",
		lg: "w-10 h-10 text-xs",
	};

	let shown = $derived(items.slice(0, max));
	let overflow = $derived(extra || Math.max(0, items.length - max));
</script>

<div
	class={`flex items-center -space-x-1.5 ${klass}`}
	aria-label={ariaLabel || undefined}
	role={ariaLabel ? "group" : undefined}
>
	{#each shown as item, i (item.initial || item.name || i)}
		<Avatar
			name={item.name}
			initial={item.initial}
			src={item.src}
			{size}
			tone={item.tone ?? tones[i % tones.length]}
		/>
	{/each}
	{#if overflow > 0}
		<span class={`inline-grid place-items-center shrink-0 rounded-full font-black leading-none ring-1 ring-black/40 bg-ws-surface2 text-ws-ink ${extraSize[size]}`}>
			+{overflow}
		</span>
	{/if}
</div>
