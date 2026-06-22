<!-- BarChart - lightweight CSS bar chart for REAL categorical metrics (pipeline
	stage counts, per-member performance, per-dimension scores). No chart library:
	each row is a labelled track + fill whose width is the value relative to a max.
	Honest empty state when there are no rows. Pure presentation — callers pass
	already-computed real values; this atom never fabricates data. -->
<script lang="ts" module>
	export type BarTone = "cyan" | "violet" | "green" | "amber" | "rose" | "blue" | "faint";

	export interface BarChartRow {
		id: string;
		label: string;
		value: number;
		/** Optional right-aligned value text; defaults to the numeric value. */
		valueLabel?: string;
		tone?: BarTone;
	}

	const FILL: Record<BarTone, string> = {
		cyan: "linear-gradient(90deg,#22D3EE,#0EA5C4)",
		violet: "linear-gradient(90deg,#8B5CF6,#D946EF)",
		green: "linear-gradient(90deg,#34D399,#22D3EE)",
		amber: "linear-gradient(90deg,#FBBF24,#FB7185)",
		rose: "#FB7185",
		blue: "linear-gradient(90deg,#3B82F6,#22D3EE)",
		faint: "#6B6B78",
	};

	// Bar width as a percent of the chart max. Exported for unit testing. A
	// non-positive or absent max collapses every bar to 0 (honest: nothing to
	// compare against), and negative values clamp to 0.
	export function barWidthPct(value: number, max: number): number {
		if (!Number.isFinite(value) || value <= 0) return 0;
		if (!Number.isFinite(max) || max <= 0) return 0;
		return Math.max(0, Math.min(100, (value / max) * 100));
	}
</script>

<script lang="ts">
	import NumberValue from "./NumberValue.svelte";
	import { _ } from "$lib/i18n";

	let {
		rows,
		max = undefined,
		emptyLabel = undefined,
		valueSuffix = "",
		class: klass = "",
	}: {
		rows: BarChartRow[];
		/** Shared scale max; defaults to the largest row value (min 1 to avoid /0). */
		max?: number;
		emptyLabel?: string;
		valueSuffix?: string;
		class?: string;
	} = $props();

	let resolvedMax = $derived(
		max !== undefined && max > 0 ? max : Math.max(1, ...rows.map((row) => (Number.isFinite(row.value) ? row.value : 0))),
	);
	// Localized empty-state copy when the caller omits an explicit label.
	let effectiveEmptyLabel = $derived(emptyLabel ?? $_("barChart.empty"));
</script>

{#if rows.length === 0}
	<div class={`py-4 text-center text-[11.5px] text-ws-faint ${klass}`}>{effectiveEmptyLabel}</div>
{:else}
	<ul class={`flex flex-col gap-2.5 ${klass}`}>
		{#each rows as row (row.id)}
			<li class="flex items-center gap-3">
				<span class="w-[88px] shrink-0 truncate text-[11.5px] text-ws-text" title={row.label}>{row.label}</span>
				<span class="ws-track h-2 flex-1 min-w-0">
					<span class="ws-fill block h-full rounded-full" style={`width:${barWidthPct(row.value, resolvedMax)}%;background:${FILL[row.tone ?? "violet"]}`}></span>
				</span>
				<span class="ws-num w-[52px] shrink-0 text-right text-[11.5px] font-medium text-ws-ink">
					{#if row.valueLabel !== undefined}
						{row.valueLabel}
					{:else}
						<NumberValue value={row.value} compact={true} /><span class="text-ws-faint font-normal">{valueSuffix}</span>
					{/if}
				</span>
			</li>
		{/each}
	</ul>
{/if}
