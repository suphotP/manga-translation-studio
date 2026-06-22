<!-- ToolbarButton - icon button with tooltip, active state, optional keyboard shortcut hint.
	Pure presentation atom for left toolbar / tool options bar buttons.
	Icon is supplied as a snippet so callers control svg/emoji content. -->
<script lang="ts">
	import type { Snippet } from "svelte";

	let {
		label,
		shortcut = "",
		active = false,
		disabled = false,
		ariaLabel = "",
		size = "md",
		tone = "default",
		onclick,
		icon,
		class: klass = "",
	}: {
		label: string;
		shortcut?: string;
		active?: boolean;
		disabled?: boolean;
		ariaLabel?: string;
		size?: "sm" | "md" | "lg";
		tone?: "default" | "accent" | "danger";
		onclick?: (event: MouseEvent) => void;
		icon: Snippet;
		class?: string;
	} = $props();

	let sizeClass = $derived(
		size === "sm"
			? "h-8 w-8 text-[12px]"
			: size === "lg"
				? "h-11 w-11 text-[16px]"
				: "h-10 w-10 text-[14px]",
	);

	let toneActiveClass = $derived(
		tone === "accent"
			? "bg-ws-accent/15 text-ws-accent border-ws-accent/30"
			: tone === "danger"
				? "bg-ws-rose/15 text-ws-rose border-ws-rose/30"
				: "bg-white/8 text-ws-ink border-ws-line/25",
	);

	let toneIdleClass = $derived(
		tone === "danger"
			? "text-ws-rose/80 hover:text-ws-rose hover:bg-ws-rose/10"
			: "text-ws-text hover:text-ws-ink hover:bg-white/5",
	);

	let combinedTitle = $derived(shortcut ? `${label} (${shortcut})` : label);
</script>

<button
	type="button"
	{disabled}
	aria-label={ariaLabel || label}
	aria-pressed={active}
	title={combinedTitle}
	onclick={(event) => {
		if (!disabled) onclick?.(event);
	}}
	class={`group relative inline-flex items-center justify-center rounded-ws-ctrl border transition ${sizeClass} ${active ? toneActiveClass : `border-transparent ${toneIdleClass}`} disabled:cursor-not-allowed disabled:opacity-40 ${klass}`}
>
	<span class="pointer-events-none flex items-center justify-center" aria-hidden="true">{@render icon()}</span>
	{#if shortcut}
		<span class="pointer-events-none absolute bottom-0.5 right-0.5 rounded bg-black/30 px-1 text-[8px] font-bold uppercase tracking-wider text-ws-faint opacity-0 transition group-hover:opacity-100">
			{shortcut}
		</span>
	{/if}
</button>
