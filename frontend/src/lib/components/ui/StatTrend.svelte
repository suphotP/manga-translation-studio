<!-- StatTrend - a headline metric with a REAL delta vs a comparison point and an
	optional inline Sparkline. Used by the dashboard analytics for AI-credit and
	throughput trends. The delta direction/color is derived from the two real
	values; when no comparison value is supplied the delta chip is hidden (honest:
	no baseline ⇒ no trend claim). Pure presentation. -->
<script lang="ts" module>
	export type TrendDirection = "up" | "down" | "flat";

	// Direction of a change from `previous` to `current`. Exported for testing.
	export function trendDirection(current: number, previous: number | null | undefined): TrendDirection {
		if (previous === null || previous === undefined || !Number.isFinite(previous) || !Number.isFinite(current)) return "flat";
		if (current > previous) return "up";
		if (current < previous) return "down";
		return "flat";
	}

	// Signed percent change from previous → current. Returns null when there is no
	// usable baseline (no previous, or previous is 0 so a ratio is undefined),
	// so the UI shows an absolute delta or nothing rather than a fake ∞%/100%.
	export function trendDeltaPct(current: number, previous: number | null | undefined): number | null {
		if (previous === null || previous === undefined || !Number.isFinite(previous) || previous === 0) return null;
		if (!Number.isFinite(current)) return null;
		return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
	}
</script>

<script lang="ts">
	import NumberValue from "./NumberValue.svelte";
	import Sparkline, { type SparklineTone } from "./Sparkline.svelte";
	import { _ } from "$lib/i18n";

	let {
		label,
		value,
		previous = null,
		prefix = "",
		suffix = "",
		compact = true,
		tone = "violet",
		// When true a rise is GOOD (green up); when false a rise is bad (e.g. spend).
		higherIsBetter = true,
		series = [],
		caption = "",
		class: klass = "",
	}: {
		label: string;
		value: number;
		previous?: number | null;
		prefix?: string;
		suffix?: string;
		compact?: boolean;
		tone?: SparklineTone;
		higherIsBetter?: boolean;
		series?: number[];
		caption?: string;
		class?: string;
	} = $props();

	let direction = $derived(trendDirection(value, previous));
	let deltaPct = $derived(trendDeltaPct(value, previous));
	let goodDirection = $derived(
		direction === "flat" ? "flat" : (direction === "up") === higherIsBetter ? "good" : "bad",
	);
	let deltaClass = $derived(
		goodDirection === "good" ? "text-ws-green" : goodDirection === "bad" ? "text-ws-amber" : "text-ws-faint",
	);
	let arrow = $derived(direction === "up" ? "↑" : direction === "down" ? "↓" : "→");
</script>

<div class={`ws-panel rounded-ws-card p-3.5 ${klass}`}>
	<div class="flex items-center justify-between gap-2">
		<p class="text-[11px] font-medium text-ws-faint truncate">{label}</p>
		{#if previous !== null && previous !== undefined}
			<span class={`ws-num inline-flex items-center gap-0.5 text-[11px] font-medium ${deltaClass}`} aria-label={$_("statTrend.trend")}>
				<span aria-hidden="true">{arrow}</span>
				{#if deltaPct !== null}
					{Math.abs(deltaPct)}%
				{:else}
					<NumberValue value={Math.abs(value - previous)} {prefix} {suffix} {compact} />
				{/if}
			</span>
		{/if}
	</div>
	<p class="mt-1 leading-none">
		<NumberValue {value} {prefix} {suffix} {compact} class={`text-[22px] font-semibold text-ws-ink`} />
	</p>
	{#if series.length >= 2}
		<div class="mt-2.5">
			<Sparkline values={series} {tone} width={150} height={30} ariaLabel={$_("statTrend.trendOf", { values: { label } })} class="w-full" />
		</div>
	{/if}
	{#if caption}
		<p class="mt-1.5 text-[10.5px] text-ws-faint">{caption}</p>
	{/if}
</div>
