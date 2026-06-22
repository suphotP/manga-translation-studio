<!-- AttentionRow - one "needs attention" item (matches the dashboard WORK & ATTENTION
	list). A toned icon badge + title/meta + optional trailing badge text. Renders as a
	button when `onclick` is given. -->
<script lang="ts">
	export type AttentionTone = "urgent" | "overdue" | "blocked" | "ai" | "mention" | "review";

	let {
		tone,
		text,
		meta = "",
		badge = "",
		onclick,
		class: klass = "",
	}: {
		tone: AttentionTone;
		text: string;
		meta?: string;
		badge?: string;
		onclick?: () => void;
		class?: string;
	} = $props();

	// Collapse the 6 semantic tones onto the ws signal colors (rose/amber/accent).
	const toneColor: Record<AttentionTone, "rose" | "amber" | "accent"> = {
		urgent: "rose",
		overdue: "rose",
		blocked: "rose",
		ai: "accent",
		mention: "accent",
		review: "amber",
	};
	const badgeClass = {
		rose: "border-ws-rose/20 bg-ws-rose/10 text-ws-rose",
		amber: "border-ws-amber/20 bg-ws-amber/10 text-ws-amber",
		accent: "border-ws-accent/20 bg-ws-accent/10 text-ws-accent",
	} as const;
	const textColor = {
		rose: "text-ws-rose",
		amber: "text-ws-amber",
		accent: "text-ws-accent",
	} as const;

	let c = $derived(toneColor[tone]);
	let base = $derived(
		`ws-row-hover flex w-full items-start gap-3 rounded-ws-ctrl px-1.5 py-2.5 text-left ${onclick ? "cursor-pointer" : ""} ${klass}`,
	);
</script>

{#snippet body()}
	<span class={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border ${badgeClass[c]}`}>
		<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8v5M12 16.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" /><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.5" /></svg>
	</span>
	<span class="min-w-0 flex-1">
		<span class="block truncate text-[13.5px] text-ws-ink">{text}</span>
		{#if meta}<span class="mt-0.5 block truncate text-[11.5px] tabular-nums text-ws-faint">{meta}</span>{/if}
	</span>
	{#if badge}<span class={`mt-0.5 shrink-0 text-[11px] font-medium ${textColor[c]}`}>{badge}</span>{/if}
{/snippet}

{#if onclick}
	<button type="button" class={base} {onclick}>{@render body()}</button>
{:else}
	<div class={base}>{@render body()}</div>
{/if}
