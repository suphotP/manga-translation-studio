<!-- NumberValue - renders a number compacted (1240 → 1.24K, 1240000 → 1.24M) with an
	optional prefix (฿) / suffix, and reveals the REAL full value on hover via both a
	native title attr and a small ws-styled tooltip. tabular-nums throughout. -->
<script lang="ts">
	let {
		value,
		prefix = "",
		suffix = "",
		compact = true,
		digits = 2,
		class: klass = "",
	}: {
		value: number;
		prefix?: string;
		suffix?: string;
		compact?: boolean;
		digits?: number;
		class?: string;
	} = $props();

	const UNITS = [
		{ limit: 1e12, suffix: "T" },
		{ limit: 1e9, suffix: "B" },
		{ limit: 1e6, suffix: "M" },
		{ limit: 1e3, suffix: "K" },
	] as const;

	function trimZeros(text: string): string {
		return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
	}

	// Full, grouped representation always shown on hover (e.g. 1,240,000).
	let full = $derived(
		`${prefix}${Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 20 }) : "—"}${suffix}`,
	);

	// Compacted display: 1240 → 1.24K. Falls back to grouped when not compact or < 1000.
	let display = $derived.by(() => {
		if (!Number.isFinite(value)) return `${prefix}—${suffix}`;
		const abs = Math.abs(value);
		if (compact && abs >= 1e3) {
			for (const unit of UNITS) {
				if (abs >= unit.limit) {
					const scaled = value / unit.limit;
					return `${prefix}${trimZeros(scaled.toFixed(digits))}${unit.suffix}${suffix}`;
				}
			}
		}
		return `${prefix}${value.toLocaleString("en-US", { maximumFractionDigits: digits })}${suffix}`;
	});

	// Only surface the tooltip affordance when the compact form actually hides detail.
	let abbreviated = $derived(display !== full);
</script>

<span class={`group relative inline-flex tabular-nums ${klass}`} title={abbreviated ? full : undefined}>
	{display}
	{#if abbreviated}
		<span
			role="tooltip"
			class="ws-panel pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-ws-ctrl px-2 py-1 text-[11px] font-semibold text-ws-ink opacity-0 transition-opacity duration-100 group-hover:opacity-100"
		>
			{full}
		</span>
	{/if}
</span>
