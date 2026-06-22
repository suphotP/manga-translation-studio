<!-- LanguageCoverageChips - source→target language chips with a coverage %, matching
	the stories mockup (e.g. "JP→TH 87%"). The % color shifts by completeness so the
	row reads at a glance. tabular-nums on the percentage. -->
<script lang="ts">
	import { formatLangCode } from "$lib/project/language-display.ts";

	export interface LanguagePair {
		from: string;
		to: string;
		pct: number;
	}

	let {
		pairs = [],
		class: klass = "",
	}: {
		pairs?: LanguagePair[];
		class?: string;
	} = $props();

	// Completeness → tone, mirroring the mockup (emerald high, amber mid, faint low).
	function pctClass(pct: number): string {
		if (pct >= 80) return "text-ws-green";
		if (pct >= 34) return "text-ws-amber";
		return "text-ws-faint";
	}

	function clamp(pct: number): number {
		return Math.max(0, Math.min(100, Math.round(pct)));
	}
</script>

<div class={`flex flex-wrap items-center gap-1.5 ${klass}`}>
	{#each pairs as pair (`${pair.from}-${pair.to}`)}
		<span class="inline-flex items-center gap-1 rounded-full border border-ws-line/15 bg-white/5 px-2 py-0.5 text-[11px] font-medium text-ws-text">
			<span class="text-ws-faint">{formatLangCode(pair.from)}→</span>{formatLangCode(pair.to)}
			<span class={`tabular-nums ${pctClass(pair.pct)}`}>{clamp(pair.pct)}%</span>
		</span>
	{/each}
</div>
