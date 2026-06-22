<!-- ChapterRow - chapter list row (matches the story/library chapter rows). Shows a
	chapter label + title, per-language progress bars, per-role badges, an optional
	revised marker, due copy, and small counts. Renders as a button when `onclick` set. -->
<script lang="ts">
	import ProgressBar, { type ProgressTone } from "./ProgressBar.svelte";
	import RoleBadge, { type WorkRole, type RoleState } from "./RoleBadge.svelte";
	import StatusPill from "./StatusPill.svelte";
	import { formatLangCode } from "$lib/project/language-display.ts";

	export interface ChapterLangProgress {
		lang: string;
		pct: number;
		tone?: ProgressTone;
	}
	export interface ChapterRoleBadge {
		role: WorkRole;
		state?: RoleState;
	}
	export interface ChapterRowCount {
		label: string;
		value: number;
		tone?: "violet" | "cyan" | "amber" | "rose" | "green" | "faint";
	}

	let {
		label,
		title,
		langs = [],
		roles = [],
		revised = false,
		due = "",
		dueLate = false,
		counts = [],
		onclick,
		class: klass = "",
	}: {
		label: string;
		title: string;
		langs?: ChapterLangProgress[];
		roles?: ChapterRoleBadge[];
		revised?: boolean;
		due?: string;
		dueLate?: boolean;
		counts?: ChapterRowCount[];
		onclick?: () => void;
		class?: string;
	} = $props();

	const countColor: Record<NonNullable<ChapterRowCount["tone"]>, string> = {
		violet: "text-ws-violet",
		cyan: "text-ws-cyan",
		amber: "text-ws-amber",
		rose: "text-ws-rose",
		green: "text-ws-green",
		faint: "text-ws-faint",
	};

	let base = $derived(
		`ws-row-hover flex w-full items-center gap-3 rounded-ws-ctrl border border-ws-line/12 bg-white/[0.02] p-3 text-left ${onclick ? "cursor-pointer" : ""} ${klass}`,
	);
</script>

{#snippet body()}
	<div class="flex min-w-[3.5rem] shrink-0 flex-col">
		<span class="text-[11px] font-bold uppercase tracking-wide text-ws-faint">{label}</span>
		{#if revised}<span class="mt-0.5 w-fit rounded border border-ws-green/25 bg-ws-green/15 px-1 text-[9px] font-semibold text-ws-green">v2</span>{/if}
	</div>

	<div class="min-w-0 flex-1">
		<p class="truncate text-[13.5px] font-medium text-ws-ink">{title}</p>
		{#if langs.length}
			<div class="mt-1.5 space-y-1">
				{#each langs as lang (lang.lang)}
					<div class="flex items-center gap-2">
						<span class="w-7 shrink-0 text-[10px] font-bold uppercase tabular-nums text-ws-faint">{formatLangCode(lang.lang)}</span>
						<ProgressBar value={lang.pct} tone={lang.tone ?? "violet"} class="flex-1" />
						<span class="w-9 shrink-0 text-right text-[11px] font-medium tabular-nums text-ws-text">{Math.round(lang.pct)}%</span>
					</div>
				{/each}
			</div>
		{/if}
		{#if roles.length}
			<div class="mt-2 flex flex-wrap gap-1">
				{#each roles as r (r.role)}<RoleBadge role={r.role} state={r.state ?? "todo"} />{/each}
			</div>
		{/if}
	</div>

	<div class="flex shrink-0 flex-col items-end gap-1.5">
		{#if due}<StatusPill label={due} tone={dueLate ? "late" : "neutral"} />{/if}
		{#if counts.length}
			<div class="flex items-center gap-2">
				{#each counts as c (c.label)}
					<span class={`inline-flex items-center gap-1 text-[10px] ${countColor[c.tone ?? "faint"]}`} title={c.label}>
						<span class="ws-dot" style="background:currentColor"></span><span class="tabular-nums">{c.value}</span>
					</span>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

{#if onclick}
	<button type="button" class={base} {onclick}>{@render body()}</button>
{:else}
	<div class={base}>{@render body()}</div>
{/if}
