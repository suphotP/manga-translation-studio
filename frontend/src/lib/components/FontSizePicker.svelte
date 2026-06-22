<!-- FontSizePicker: preset buttons and custom input for font sizes -->
<script lang="ts">
	import { _ } from "$lib/i18n";

	interface Props {
		selectedSize: number;
		onSizeChange: (size: number) => void;
		disabled?: boolean;
		compact?: boolean;
	}

	let { selectedSize, onSizeChange, disabled = false, compact = false }: Props = $props();

	const presetSizes = [12, 14, 16, 18, 24, 32, 48];
	const minSize = 8;
	const maxSize = 200;

	let customValue = $derived(String(selectedSize));
	let showCustomInput = $state(false);
	// Mutable edit buffer, seeded once from the prop; intentionally not reactive
	// (the reactive view lives in `customValue` above).
	// svelte-ignore state_referenced_locally
	let tempCustomValue = $state(String(selectedSize));
	const customNumber = $derived(parseInt(tempCustomValue, 10));
	const canDecreaseCustomSize = $derived(!isNaN(customNumber) && customNumber > minSize);
	const canIncreaseCustomSize = $derived(!isNaN(customNumber) && customNumber < maxSize);
	const selectedNumber = $derived(Number.isFinite(Number(selectedSize)) ? Number(selectedSize) : minSize);
	const canDecreaseSelectedSize = $derived(selectedNumber > minSize);
	const canIncreaseSelectedSize = $derived(selectedNumber < maxSize);

	function selectPreset(size: number) {
		if (disabled) return;
		tempCustomValue = String(size);
		showCustomInput = false;
		onSizeChange(size);
	}

	function handleCustomInput() {
		if (disabled) return;
		tempCustomValue = customValue;
		showCustomInput = true;
	}

	function handleCustomChange(e: Event) {
		if (disabled) return;
		const value = (e.target as HTMLInputElement).value;
		tempCustomValue = value;

		const numValue = parseInt(value, 10);
		if (!isNaN(numValue) && numValue >= minSize && numValue <= maxSize) {
			onSizeChange(numValue);
		}
	}

	function handleCustomBlur() {
		if (disabled) return;
		// Validate and clamp value on blur
		let numValue = parseInt(tempCustomValue, 10);
		if (isNaN(numValue) || numValue < minSize) {
			numValue = minSize;
		} else if (numValue > maxSize) {
			numValue = maxSize;
		}
		tempCustomValue = String(numValue);
		onSizeChange(numValue);
		showCustomInput = false;
	}

	function incrementSize() {
		if (disabled) return;
		let newValue = parseInt(tempCustomValue, 10) + 2;
		if (newValue > maxSize) newValue = maxSize;
		tempCustomValue = String(newValue);
		onSizeChange(newValue);
	}

	function decrementSize() {
		if (disabled) return;
		let newValue = parseInt(tempCustomValue, 10) - 2;
		if (newValue < minSize) newValue = minSize;
		tempCustomValue = String(newValue);
		onSizeChange(newValue);
	}

	function adjustSelectedSize(delta: number) {
		if (disabled) return;
		const nextSize = Math.max(minSize, Math.min(maxSize, Math.round(selectedNumber + delta)));
		tempCustomValue = String(nextSize);
		onSizeChange(nextSize);
	}

	function handleCompactInput(e: Event) {
		if (disabled) return;
		const value = (e.target as HTMLInputElement).value;
		tempCustomValue = value;
		const numValue = parseInt(value, 10);
		if (!isNaN(numValue) && numValue >= minSize && numValue <= maxSize) {
			onSizeChange(numValue);
		}
	}

	function handleCompactBlur() {
		if (disabled) return;
		let numValue = parseInt(tempCustomValue, 10);
		if (isNaN(numValue) || numValue < minSize) {
			numValue = minSize;
		} else if (numValue > maxSize) {
			numValue = maxSize;
		}
		tempCustomValue = String(numValue);
		onSizeChange(numValue);
	}
</script>

<div class="font-size-picker" class:compact>
	{#if disabled}
		<div class="font-size-readonly" role="status" aria-label={$_("fontSizePicker.readonlyLabel")}>
			<strong>{selectedSize}px</strong>
			<span>{$_("fontSizePicker.readonlyValue")}</span>
		</div>
	{:else if compact}
		<div class="font-size-compact" aria-label={$_("fontSizePicker.compactLabel")}>
			{#if canDecreaseSelectedSize}
				<button type="button" class="size-adjust-btn" onclick={() => adjustSelectedSize(-2)} aria-label={$_("fontSizePicker.decrease")}>
					−
				</button>
			{:else}
				<span class="size-adjust-receipt" aria-label={$_("fontSizePicker.minLabel")}>{$_("fontSizePicker.min")}</span>
			{/if}
			<input
				type="number"
				class="size-input compact-input"
				value={selectedSize}
				oninput={handleCompactInput}
				onblur={handleCompactBlur}
				min={minSize}
				max={maxSize}
				aria-label={$_("fontSizePicker.fontSize")}
			/>
			<span class="size-unit">px</span>
			{#if canIncreaseSelectedSize}
				<button type="button" class="size-adjust-btn" onclick={() => adjustSelectedSize(2)} aria-label={$_("fontSizePicker.increase")}>
					+
				</button>
			{:else}
				<span class="size-adjust-receipt" aria-label={$_("fontSizePicker.maxLabel")}>{$_("fontSizePicker.max")}</span>
			{/if}
		</div>
	{:else}
		<div class="font-size-presets">
			{#each presetSizes as size (size)}
				<button
					type="button"
					class="size-chip"
					class:selected={size === selectedSize}
					onclick={() => selectPreset(size)}
				>
					{size}
				</button>
			{/each}
			<button
				type="button"
				class="size-chip custom-chip"
				class:active={showCustomInput}
				onclick={handleCustomInput}
			>
				{$_("fontSizePicker.custom")}
			</button>
		</div>
	{/if}

	{#if showCustomInput && !disabled}
		<div class="font-size-custom">
			{#if canDecreaseCustomSize}
				<button type="button" class="size-adjust-btn" onclick={decrementSize} aria-label={$_("fontSizePicker.decrease")}>
					−
				</button>
			{:else}
				<span class="size-adjust-receipt" aria-label={$_("fontSizePicker.minLabel")}>{$_("fontSizePicker.min")}</span>
			{/if}
			<input
				type="number"
				class="size-input"
				bind:value={tempCustomValue}
				oninput={handleCustomChange}
				onblur={handleCustomBlur}
				min={minSize}
				max={maxSize}
			/>
			{#if canIncreaseCustomSize}
				<button type="button" class="size-adjust-btn" onclick={incrementSize} aria-label={$_("fontSizePicker.increase")}>
					+
				</button>
			{:else}
				<span class="size-adjust-receipt" aria-label={$_("fontSizePicker.maxLabel")}>{$_("fontSizePicker.max")}</span>
			{/if}
			<span class="size-unit">px</span>
		</div>
	{/if}

	{#if !compact}
		<div class="font-size-preview">
			<span style="font-size: {Math.min(selectedSize, 48)}px">
				Aa
			</span>
		</div>
	{/if}
</div>

<style>
	.font-size-picker {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.font-size-picker.compact {
		flex-direction: row;
		align-items: center;
		gap: 0;
	}

	.font-size-compact {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 40px;
		min-width: 150px;
		padding: 0 4px;
		border: 1px solid var(--editor-border);
		border-radius: 6px;
		background: var(--editor-bg);
	}

	.font-size-presets {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.size-chip {
		min-width: 40px;
		min-height: 40px;
		padding: 7px 9px;
		border: 1px solid var(--editor-border);
		border-radius: 4px;
		background: var(--editor-bg);
		color: var(--editor-text);
		font-size: 11px;
		cursor: pointer;
		transition: background 0.15s, border-color 0.15s;
	}

	.size-chip:hover {
		background: var(--editor-border);
	}

	.size-chip.selected {
		background: var(--editor-accent);
		border-color: var(--editor-accent);
		color: #ffffff;
	}

	.custom-chip {
		flex: 1;
		min-width: 60px;
	}

	.custom-chip.active {
		background: var(--editor-accent);
		border-color: var(--editor-accent);
		color: #ffffff;
	}

	.font-size-readonly {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-height: 40px;
		padding: 7px 10px;
		border: 1px solid var(--editor-border);
		border-radius: 4px;
		background: var(--editor-bg);
		color: var(--editor-text);
		opacity: 0.45;
	}

	.font-size-readonly span {
		color: var(--editor-text-dim);
		font-size: 10px;
		white-space: nowrap;
	}

	.font-size-custom {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px;
		border: 1px solid var(--editor-border);
		border-radius: 4px;
		background: var(--editor-bg);
	}

	.size-adjust-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border: none;
		border-radius: 3px;
		background: var(--editor-border);
		color: var(--editor-text);
		font-size: 14px;
		cursor: pointer;
		line-height: 1;
	}

	.size-adjust-receipt {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 40px;
		min-height: 40px;
		padding: 0 6px;
		border-radius: 3px;
		background: var(--editor-border);
		color: var(--editor-text-dim);
		font-size: 10px;
		line-height: 1;
	}

	.size-adjust-btn:hover {
		background: var(--editor-accent);
		color: #ffffff;
	}

	.size-input {
		flex: 1;
		width: 0;
		min-height: 40px;
		padding: 5px 6px;
		border: none;
		background: transparent;
		color: var(--editor-text);
		font-size: 12px;
		text-align: center;
		outline: none;
	}

	.compact-input {
		width: 46px;
		min-width: 46px;
		flex: 0 0 46px;
		text-align: center;
	}

	.size-input::-webkit-inner-spin-button,
	.size-input::-webkit-outer-spin-button {
		-webkit-appearance: none;
		margin: 0;
	}

	.size-unit {
		font-size: 11px;
		color: var(--editor-text-dim);
		margin-right: 4px;
	}

	.font-size-preview {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 40px;
		border: 1px solid var(--editor-border);
		border-radius: 4px;
		background: var(--editor-bg);
		color: var(--editor-text);
	}
</style>
