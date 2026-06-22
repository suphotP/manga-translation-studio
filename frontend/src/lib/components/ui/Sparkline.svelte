<!-- Sparkline - lightweight inline-SVG line/area chart for a REAL numeric series.
	No chart library: the path is computed from the supplied points. Renders an
	honest empty state when there is no series or fewer than two points (a single
	point is not a trend). Pure presentation — callers pass already-computed,
	real values; this atom never fabricates or interpolates extra data. -->
<script lang="ts" module>
	export type SparklineTone = "cyan" | "violet" | "green" | "amber" | "rose";

	const STROKE: Record<SparklineTone, string> = {
		cyan: "#22D3EE",
		violet: "#8B5CF6",
		green: "#34D399",
		amber: "#FBBF24",
		rose: "#FB7185",
	};

	// Build the SVG polyline/area path coordinates for a series within a viewBox.
	// Exported so the geometry can be unit-tested without rendering. A flat series
	// (max === min) is pinned to the vertical midline so it reads as "no change"
	// rather than collapsing to the floor.
	export function sparklinePoints(
		values: number[],
		width: number,
		height: number,
		pad = 2,
	): Array<{ x: number; y: number }> {
		const finite = values.filter((v) => Number.isFinite(v));
		if (finite.length === 0) return [];
		const innerW = Math.max(1, width - pad * 2);
		const innerH = Math.max(1, height - pad * 2);
		const max = Math.max(...finite);
		const min = Math.min(...finite);
		const span = max - min;
		const stepX = finite.length > 1 ? innerW / (finite.length - 1) : 0;
		return finite.map((value, index) => {
			const x = pad + (finite.length > 1 ? index * stepX : innerW / 2);
			const ratio = span === 0 ? 0.5 : (value - min) / span;
			// SVG y grows downward, so higher values sit nearer the top.
			const y = pad + (1 - ratio) * innerH;
			return { x: round2(x), y: round2(y) };
		});
	}

	export function sparklineLinePath(points: Array<{ x: number; y: number }>): string {
		if (points.length === 0) return "";
		return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
	}

	export function sparklineAreaPath(
		points: Array<{ x: number; y: number }>,
		height: number,
		pad = 2,
	): string {
		if (points.length === 0) return "";
		const baseline = height - pad;
		const first = points[0]!;
		const last = points[points.length - 1]!;
		const line = sparklineLinePath(points);
		return `${line} L${last.x} ${baseline} L${first.x} ${baseline} Z`;
	}

	function round2(value: number): number {
		return Math.round(value * 100) / 100;
	}
</script>

<script lang="ts">
	import { _ } from "$lib/i18n";

	let {
		values,
		tone = "violet",
		width = 120,
		height = 36,
		strokeWidth = 1.75,
		area = true,
		emptyLabel = undefined,
		ariaLabel = "",
		class: klass = "",
	}: {
		values: number[];
		tone?: SparklineTone;
		width?: number;
		height?: number;
		strokeWidth?: number;
		area?: boolean;
		emptyLabel?: string;
		ariaLabel?: string;
		class?: string;
	} = $props();

	const gradId = `spark-${Math.random().toString(36).slice(2, 9)}`;
	let points = $derived(sparklinePoints(values, width, height));
	// A single point is not a trend — require at least two real points to draw.
	let hasSeries = $derived(points.length >= 2);
	let linePath = $derived(sparklineLinePath(points));
	let areaPath = $derived(sparklineAreaPath(points, height));
	let stroke = $derived(STROKE[tone]);
	let last = $derived(points[points.length - 1]);
	// Localized empty-state copy when the caller omits an explicit label.
	let effectiveEmptyLabel = $derived(emptyLabel ?? $_("sparkline.empty"));
</script>

{#if hasSeries}
	<svg
		class={`block ${klass}`}
		viewBox={`0 0 ${width} ${height}`}
		width={width}
		height={height}
		preserveAspectRatio="none"
		role="img"
		aria-label={ariaLabel || undefined}
	>
		<defs>
			<linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
				<stop offset="0%" stop-color={stroke} stop-opacity="0.28" />
				<stop offset="100%" stop-color={stroke} stop-opacity="0" />
			</linearGradient>
		</defs>
		{#if area}
			<path d={areaPath} fill={`url(#${gradId})`} stroke="none" />
		{/if}
		<path d={linePath} fill="none" stroke={stroke} stroke-width={strokeWidth} stroke-linecap="round" stroke-linejoin="round" />
		{#if last}
			<circle cx={last.x} cy={last.y} r={strokeWidth + 0.6} fill={stroke} />
		{/if}
	</svg>
{:else}
	<div class={`flex items-center text-[10.5px] text-ws-faint ${klass}`} style={`min-height:${height}px`}>
		{effectiveEmptyLabel}
	</div>
{/if}
