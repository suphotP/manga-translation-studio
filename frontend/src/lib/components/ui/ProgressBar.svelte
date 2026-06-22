<!-- ProgressBar - shared progress track used by story/chapter/dashboard. -->
<script lang="ts">
	export type ProgressTone = "accent" | "cyan" | "green" | "amber" | "rose" | "violet";

	let {
		value = 0,
		tone = "accent",
		gradient,
		showLabel = false,
		ariaLabel = "",
		class: klass = "",
	}: {
		value?: number;
		tone?: ProgressTone;
		gradient?: string;
		showLabel?: boolean;
		ariaLabel?: string;
		class?: string;
	} = $props();

	const fillClass: Record<ProgressTone, string> = {
		accent: "bg-ws-accent",
		cyan: "bg-ws-cyan",
		green: "bg-ws-green",
		amber: "bg-ws-amber",
		rose: "bg-ws-rose",
		violet: "bg-ws-violet",
	};

	const namedGradients: Record<string, string> = {
		"violet-fuchsia": "linear-gradient(90deg,#8b5cf6,#d946ef)",
		"cyan-violet": "linear-gradient(90deg,#22d3ee,#8b5cf6)",
		"cyan-accent": "linear-gradient(90deg,#22d3ee,#7c5cff)",
		"green-cyan": "linear-gradient(90deg,#34d399,#22d3ee)",
		"amber-rose": "linear-gradient(90deg,#fbbf24,#fb7185)",
	};

	let resolvedGradient = $derived(
		gradient
			? (namedGradients[gradient] || gradient)
			: undefined
	);

	let pct = $derived(Math.max(0, Math.min(100, Math.round(value))));
</script>

<div class={`flex items-center gap-2 ${klass}`}>
	<div
		class="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10"
		role="progressbar"
		aria-valuenow={pct}
		aria-valuemin="0"
		aria-valuemax="100"
		aria-label={ariaLabel || undefined}
	>
		{#if resolvedGradient}
			<div class="h-full rounded-full" style={`width:${pct}%; background:${resolvedGradient}`}></div>
		{:else}
			<div class={`h-full rounded-full ${fillClass[tone]}`} style={`width:${pct}%`}></div>
		{/if}
	</div>
	{#if showLabel}
		<strong class="text-xs font-black text-ws-ink">{pct}%</strong>
	{/if}
</div>
