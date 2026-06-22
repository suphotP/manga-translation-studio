<!-- PipelineStage - one production-pipeline tile (matches the dashboard PRODUCTION
	PIPELINE band). Shows a labelled stage with a big count, an optional progress fill,
	an active highlight, and an optional avatar stack. -->
<script lang="ts">
	import NumberValue from "./NumberValue.svelte";
	import AvatarStack, { type AvatarStackItem } from "./AvatarStack.svelte";

	export type PipelineTone = "cyan" | "blue" | "violet" | "amber" | "green" | "rose" | "faint";

	let {
		label,
		labelEn = "",
		count,
		progress,
		tone = "violet",
		active = false,
		caption = "",
		avatars = [],
		class: klass = "",
	}: {
		label: string;
		labelEn?: string;
		count: number;
		progress?: number;
		tone?: PipelineTone;
		active?: boolean;
		caption?: string;
		avatars?: AvatarStackItem[];
		class?: string;
	} = $props();

	const dotClass: Record<PipelineTone, string> = {
		cyan: "bg-ws-cyan",
		blue: "bg-ws-blue",
		violet: "bg-ws-violet",
		amber: "bg-ws-amber",
		green: "bg-ws-green",
		rose: "bg-ws-rose",
		faint: "bg-ws-faint",
	};
	const fillColor: Record<PipelineTone, string> = {
		cyan: "var(--color-ws-cyan)",
		blue: "var(--color-ws-blue)",
		violet: "var(--color-ws-violet)",
		amber: "var(--color-ws-amber)",
		green: "var(--color-ws-green)",
		rose: "var(--color-ws-rose)",
		faint: "var(--color-ws-faint)",
	};

	let pct = $derived(progress == null ? null : Math.max(0, Math.min(100, Math.round(progress))));

	// `labelEn` is the bilingual companion (e.g. Thai label · "Clean"). In the
	// English locale the primary `label` IS already "Clean", so rendering labelEn
	// too would show the heading twice ("Clean Clean"). Suppress it whenever it
	// matches the primary label (case-insensitive) so the eyebrow never duplicates.
	let showLabelEn = $derived(
		Boolean(labelEn) && labelEn.trim().toLowerCase() !== label.trim().toLowerCase(),
	);
</script>

<div class={`ws-panel relative overflow-hidden rounded-ws-card p-3.5 ${active ? "border-ws-accent/30" : ""} ${klass}`}>
	{#if active}
		<div class="ws-grad-primary-soft pointer-events-none absolute inset-0 rounded-ws-card opacity-50"></div>
	{/if}
	<div class="relative">
		<div class="mb-2.5 flex items-center justify-between gap-2">
			<span class={`flex items-center gap-2 text-[12.5px] font-medium ${active ? "text-ws-ink" : "text-ws-text"}`}>
				<span class={`ws-dot ${dotClass[tone]}`}></span>{label}
			</span>
			{#if showLabelEn}<span class="shrink-0 text-[11px] text-ws-faint">{labelEn}</span>{/if}
		</div>
		<NumberValue value={count} class="text-[22px] font-semibold leading-none text-ws-ink" />
		{#if pct != null}
			<div class="ws-track mt-3 h-1"><div class="ws-fill" style={`width:${pct}%;background:${fillColor[tone]}`}></div></div>
		{/if}
		{#if caption}
			<p class="mt-1.5 text-[10.5px] text-ws-faint">{caption}</p>
		{/if}
		{#if avatars.length}
			<div class="mt-2"><AvatarStack items={avatars} size="xs" /></div>
		{/if}
	</div>
</div>
