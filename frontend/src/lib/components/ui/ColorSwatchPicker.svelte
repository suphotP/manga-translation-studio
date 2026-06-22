<!-- ColorSwatchPicker - swatch grid + hex input + recently-used row.
	Pure presentation atom for picking a color (text fill, stroke, brush).
	Caller owns palette + recent list state. -->
<script lang="ts">
	let {
		value,
		palette = [
			"#FFFFFF",
			"#000000",
			"#FB7185",
			"#FBBF24",
			"#34D399",
			"#22D3EE",
			"#8B5CF6",
			"#7C5CFF",
		],
		recent = [],
		ariaLabel = "Color picker",
		showHex = true,
		showRecent = true,
		onChange,
		class: klass = "",
	}: {
		value: string;
		palette?: readonly string[];
		recent?: readonly string[];
		ariaLabel?: string;
		showHex?: boolean;
		showRecent?: boolean;
		onChange?: (color: string) => void;
		class?: string;
	} = $props();

	let hexInput = $state(value);

	$effect(() => {
		hexInput = value;
	});

	function normalizeHex(input: string): string | null {
		const trimmed = input.trim();
		if (!trimmed) return null;
		const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
		if (/^#[0-9a-fA-F]{6}$/.test(withHash) || /^#[0-9a-fA-F]{3}$/.test(withHash)) {
			return withHash.toUpperCase();
		}
		return null;
	}

	function commitHex(): void {
		const next = normalizeHex(hexInput);
		if (next) {
			onChange?.(next);
		} else {
			hexInput = value;
		}
	}

	function handleSwatch(color: string): void {
		onChange?.(color);
	}

	function isActive(color: string): boolean {
		return color.toUpperCase() === value.toUpperCase();
	}
</script>

<div class={`flex flex-col gap-2 ${klass}`} aria-label={ariaLabel}>
	<div class="grid grid-cols-8 gap-1.5" role="listbox" aria-label="Color palette">
		{#each palette as color (color)}
			<button
				type="button"
				role="option"
				aria-selected={isActive(color)}
				aria-label={color}
				class={`h-6 w-6 rounded-md border transition ${isActive(color) ? "border-ws-accent ring-2 ring-ws-accent/40" : "border-ws-line/15 hover:border-ws-line/30"}`}
				style:background-color={color}
				onclick={() => handleSwatch(color)}
			></button>
		{/each}
	</div>

	{#if showRecent && recent.length > 0}
		<div class="flex flex-col gap-1">
			<span class="text-[10px] font-semibold uppercase tracking-wide text-ws-faint">Recent</span>
			<div class="flex flex-wrap gap-1.5" role="listbox" aria-label="Recently used colors">
				{#each recent as color (color)}
					<button
						type="button"
						role="option"
						aria-selected={isActive(color)}
						aria-label={color}
						class={`h-5 w-5 rounded border transition ${isActive(color) ? "border-ws-accent ring-2 ring-ws-accent/40" : "border-ws-line/15 hover:border-ws-line/30"}`}
						style:background-color={color}
						onclick={() => handleSwatch(color)}
					></button>
				{/each}
			</div>
		</div>
	{/if}

	{#if showHex}
		<div class="flex items-center gap-2">
			<span
				class="h-6 w-6 rounded-md border border-ws-line/15"
				style:background-color={value}
				aria-hidden="true"
			></span>
			<input
				type="text"
				class="w-24 rounded-ws-ctrl border border-ws-line/15 bg-ws-surface/60 px-2 py-1 text-[11px] font-mono uppercase tracking-wide text-ws-ink outline-none focus:border-ws-accent/50"
				bind:value={hexInput}
				onblur={commitHex}
				onkeydown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						commitHex();
					}
				}}
				aria-label="Hex color value"
				maxlength={7}
				spellcheck={false}
			/>
		</div>
	{/if}
</div>
