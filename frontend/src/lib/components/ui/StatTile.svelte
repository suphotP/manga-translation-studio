<!-- StatTile - quiet metric tile (matches the dashboard studio-overview stat blocks).
	Pairs a small label with a large number rendered through NumberValue. An optional
	`unit` suffix renders faint after the value; `tone` tints the value color. -->
<script lang="ts">
	import NumberValue from "./NumberValue.svelte";

	export type StatTone = "neutral" | "cyan" | "violet" | "green" | "amber" | "rose";

	let {
		label,
		value,
		unit = "",
		prefix = "",
		tone = "neutral",
		compact = true,
		class: klass = "",
	}: {
		label: string;
		value: number;
		unit?: string;
		prefix?: string;
		tone?: StatTone;
		compact?: boolean;
		class?: string;
	} = $props();

	const toneClass: Record<StatTone, string> = {
		neutral: "text-ws-ink",
		cyan: "text-ws-cyan",
		violet: "text-ws-violet",
		green: "text-ws-green",
		amber: "text-ws-amber",
		rose: "text-ws-rose",
	};
</script>

<div class={`ws-panel rounded-ws-card p-3.5 ${klass}`}>
	<p class="text-[11px] font-medium text-ws-faint">{label}</p>
	<p class="mt-1 flex items-baseline gap-1 leading-none">
		<NumberValue {value} {prefix} {compact} class={`text-[22px] font-semibold ${toneClass[tone]}`} />
		{#if unit}<span class="text-[12px] font-normal text-ws-faint">{unit}</span>{/if}
	</p>
</div>
