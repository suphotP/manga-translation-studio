<!-- SliderInput - labeled range slider with value display, min/max/step.
	Pure presentation atom. ws-token styled. No store, no side effects beyond onChange.
	Typical use: opacity, brush size, stroke width, slider controls in LayersInspectorPanel. -->
<script lang="ts">
	let {
		label,
		value,
		min = 0,
		max = 100,
		step = 1,
		suffix = "",
		ariaLabel = "",
		disabled = false,
		showValue = true,
		valueFormatter,
		onChange,
		onInput,
		class: klass = "",
	}: {
		label?: string;
		value: number;
		min?: number;
		max?: number;
		step?: number;
		suffix?: string;
		ariaLabel?: string;
		disabled?: boolean;
		showValue?: boolean;
		valueFormatter?: (value: number) => string;
		onChange?: (value: number) => void;
		onInput?: (value: number) => void;
		class?: string;
	} = $props();

	let display = $derived(valueFormatter ? valueFormatter(value) : `${value}${suffix}`);

	function handleInput(event: Event): void {
		const next = Number((event.currentTarget as HTMLInputElement).value);
		onInput?.(next);
	}

	function handleChange(event: Event): void {
		const next = Number((event.currentTarget as HTMLInputElement).value);
		onChange?.(next);
	}
</script>

<div class={`flex flex-col gap-1 ${klass}`}>
	{#if label || showValue}
		<div class="flex items-center justify-between gap-2 text-[11px] font-semibold text-ws-text">
			{#if label}<span class="truncate">{label}</span>{/if}
			{#if showValue}<span class="tabular-nums text-ws-ink">{display}</span>{/if}
		</div>
	{/if}
	<input
		type="range"
		class="ws-slider h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-ws-accent disabled:cursor-not-allowed disabled:opacity-50"
		{min}
		{max}
		{step}
		{value}
		{disabled}
		aria-label={ariaLabel || label || undefined}
		oninput={handleInput}
		onchange={handleChange}
	/>
</div>
