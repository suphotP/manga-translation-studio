<!-- SegmentedControl - iOS-style toggle group. Generic over option id type.
	Pure presentation atom. Caller owns active state. Styled with .ws-seg utilities. -->
<script lang="ts" generics="Id extends string">
	import type { Snippet } from "svelte";

	interface SegmentedOption<I extends string> {
		id: I;
		label: string;
		ariaLabel?: string;
		disabled?: boolean;
	}

	let {
		options,
		value,
		ariaLabel = "Segmented control",
		size = "md",
		fullWidth = false,
		onChange,
		class: klass = "",
		trailing,
	}: {
		options: readonly SegmentedOption<Id>[];
		value: Id;
		ariaLabel?: string;
		size?: "sm" | "md";
		fullWidth?: boolean;
		onChange: (id: Id) => void;
		class?: string;
		trailing?: Snippet;
	} = $props();

	let sizeClass = $derived(size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-3 py-1 text-[11px]");
</script>

<div class={`inline-flex items-center gap-2 ${klass}`}>
	<div
		class={`ws-panel-quiet inline-flex items-center gap-1 rounded-ws-ctrl p-0.5 ${fullWidth ? "w-full" : ""}`}
		role="tablist"
		aria-label={ariaLabel}
	>
		{#each options as option (option.id)}
			{@const isActive = option.id === value}
			<button
				type="button"
				role="tab"
				aria-selected={isActive}
				aria-label={option.ariaLabel || option.label}
				disabled={option.disabled}
				class={`ws-seg rounded-[7px] font-medium ${sizeClass} ${isActive ? "ws-seg-on" : ""} ${fullWidth ? "flex-1" : ""} disabled:cursor-not-allowed disabled:opacity-50`}
				onclick={() => {
					if (!option.disabled && option.id !== value) onChange(option.id);
				}}
			>
				{option.label}
			</button>
		{/each}
	</div>
	{#if trailing}{@render trailing()}{/if}
</div>
