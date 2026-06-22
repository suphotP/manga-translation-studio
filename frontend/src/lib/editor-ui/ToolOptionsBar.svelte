<script lang="ts">
	import ColorPickerPopover from "./ColorPickerPopover.svelte";

	type ToolDescriptor = {
		id: string;
		label: string;
	};

	type SelectChoice = string | {
		label: string;
		value: string;
	};

	type BaseOption = {
		id: string;
		label: string;
	};

	type SliderOption = BaseOption & {
		kind: "slider";
		value: number;
		min?: number;
		max?: number;
	};

	type ToggleOption = BaseOption & {
		kind: "toggle";
		value: boolean;
	};

	type SelectOption = BaseOption & {
		kind: "select";
		value: string;
		choices?: readonly SelectChoice[];
	};

	type NumberOption = BaseOption & {
		kind: "number";
		value: number;
		min?: number;
		max?: number;
	};

	type ColorOption = BaseOption & {
		kind: "color";
		value: string;
		recent?: readonly string[];
	};

	type ToolOption = SliderOption | ToggleOption | SelectOption | NumberOption | ColorOption;
	type ToolOptionValue = string | number | boolean;

	type Props = {
		tool: ToolDescriptor;
		options: readonly ToolOption[];
		onChange: (id: string, value: ToolOptionValue) => void;
	};

	let { tool, options, onChange }: Props = $props();
	let openColorOptionId = $state<string | null>(null);

	function choiceLabel(choice: SelectChoice): string {
		return typeof choice === "string" ? choice : choice.label;
	}

	function choiceValue(choice: SelectChoice): string {
		return typeof choice === "string" ? choice : choice.value;
	}

	function sliderMin(option: SliderOption): number {
		return option.min ?? Math.min(0, option.value);
	}

	function sliderMax(option: SliderOption): number {
		return option.max ?? Math.max(100, option.value);
	}

	function clampNumber(value: number, option: SliderOption | NumberOption): number {
		// Keep paired range/number controls from emitting values the active tool cannot accept.
		const lower = option.min ?? -Infinity;
		const upper = option.max ?? Infinity;
		return Math.min(Math.max(value, lower), upper);
	}

	function readNumber(event: Event): number | null {
		const input = event.currentTarget as HTMLInputElement;
		return Number.isNaN(input.valueAsNumber) ? null : input.valueAsNumber;
	}

	function handleNumericChange(option: SliderOption | NumberOption, event: Event) {
		const value = readNumber(event);
		if (value === null) return;
		onChange(option.id, clampNumber(value, option));
	}

	function handleToggleChange(option: ToggleOption, event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		onChange(option.id, input.checked);
	}

	function handleSelectChange(option: SelectOption, event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		onChange(option.id, select.value);
	}

	function toggleColorOption(option: ColorOption): void {
		openColorOptionId = openColorOptionId === option.id ? null : option.id;
	}

	function handleColorPick(option: ColorOption, value: string): void {
		onChange(option.id, value);
	}
</script>

<section class="tool-options-bar ws-sans" aria-label={`ตัวเลือกเครื่องมือ ${tool.label}`} data-tool-id={tool.id}>
	<div class="tool-receipt" aria-label="เครื่องมือที่เลือก">
		<span class="tool-kicker">เครื่องมือ</span>
		<strong>{tool.label}</strong>
	</div>

	{#if options.length > 0}
		<div class="options-list" role="toolbar" aria-label={`ตั้งค่า ${tool.label}`}>
			{#each options as option (option.id)}
				{#if option.kind === "slider"}
					<div class="option-control option-control-slider" role="group" aria-labelledby={`${tool.id}-${option.id}-label`}>
						<span class="option-label" id={`${tool.id}-${option.id}-label`}>{option.label}</span>
						<input
							class="range-input"
							type="range"
							min={sliderMin(option)}
							max={sliderMax(option)}
							value={option.value}
							aria-label={`${option.label} สไลเดอร์`}
							oninput={(event) => handleNumericChange(option, event)}
						/>
						<input
							class="number-input number-input-paired"
							type="number"
							min={option.min}
							max={option.max}
							value={option.value}
							aria-label={`${option.label} ตัวเลข`}
							oninput={(event) => handleNumericChange(option, event)}
						/>
					</div>
				{:else if option.kind === "toggle"}
					<label class="option-control option-control-toggle">
						<span class="option-label">{option.label}</span>
						<input
							class="toggle-input"
							type="checkbox"
							checked={option.value}
							onchange={(event) => handleToggleChange(option, event)}
						/>
					</label>
				{:else if option.kind === "select"}
					<label class="option-control option-control-select">
						<span class="option-label">{option.label}</span>
						<select
							class="select-input"
							value={option.value}
							disabled={(option.choices ?? []).length === 0}
							onchange={(event) => handleSelectChange(option, event)}
						>
							{#if (option.choices ?? []).length === 0}
								<option value="">ไม่มีตัวเลือก</option>
							{:else}
								{#each option.choices ?? [] as choice (choiceValue(choice))}
									<option value={choiceValue(choice)}>{choiceLabel(choice)}</option>
								{/each}
							{/if}
						</select>
					</label>
				{:else if option.kind === "color"}
					<div class="option-control option-control-color">
						<span class="option-label">{option.label}</span>
						<button
							type="button"
							class="color-trigger"
							aria-label={`${option.label} ${option.value}`}
							aria-expanded={openColorOptionId === option.id}
							onclick={() => toggleColorOption(option)}
						>
							<span class="color-swatch" style:background-color={option.value}></span>
							<span class="color-value">{option.value}</span>
						</button>
						<div class="color-popover-anchor">
							<ColorPickerPopover
								color={option.value}
								recent={[...(option.recent ?? [])]}
								open={openColorOptionId === option.id}
								label={option.label}
								title={`เลือก${option.label}`}
								ariaLabel={`ตัวเลือก${option.label}`}
								onPick={(value) => handleColorPick(option, value)}
								onClose={() => {
									openColorOptionId = null;
								}}
							/>
						</div>
					</div>
				{:else}
					<label class="option-control option-control-number">
						<span class="option-label">{option.label}</span>
						<input
							class="number-input"
							type="number"
							min={option.min}
							max={option.max}
							value={option.value}
							oninput={(event) => handleNumericChange(option, event)}
						/>
					</label>
				{/if}
			{/each}
		</div>
	{:else}
		<p class="empty-options" role="status">ไม่มีตัวเลือกสำหรับเครื่องมือนี้</p>
	{/if}
</section>

<style>
	.tool-options-bar {
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		height: 40px;
		width: 100%;
		overflow: hidden;
		padding: 4px 8px;
		border-bottom: 1px solid color-mix(in srgb, var(--color-ws-line) 18%, transparent);
		background:
			linear-gradient(180deg, color-mix(in srgb, var(--color-ws-surface2) 92%, transparent), var(--color-ws-surface));
		color: var(--color-ws-ink);
		font-size: 12px;
	}

	.tool-receipt {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: 0 0 auto;
		min-width: 0;
		max-width: 180px;
		height: 30px;
		padding: 0 9px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 32%, transparent);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
	}

	.tool-receipt strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		font-weight: 700;
		color: var(--color-ws-ink);
	}

	.tool-kicker {
		flex: 0 0 auto;
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		color: var(--color-ws-faint);
	}

	.options-list {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: 1 1 auto;
		min-width: 0;
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: thin;
	}

	.option-control {
		box-sizing: border-box;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex: 0 0 auto;
		min-height: 30px;
		padding: 0 7px;
		border: 1px solid color-mix(in srgb, var(--color-ws-line) 16%, transparent);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-ws-bg) 62%, transparent);
		color: var(--color-ws-text);
	}

	.option-control-slider {
		max-width: 240px;
	}

	.option-label {
		flex: 0 0 auto;
		font-size: 11px;
		font-weight: 700;
		line-height: 1;
		color: var(--color-ws-text);
		white-space: nowrap;
	}

	input,
	select {
		box-sizing: border-box;
		border: 1px solid color-mix(in srgb, var(--color-ws-line) 18%, transparent);
		border-radius: 7px;
		background: var(--color-ws-bg);
		color: var(--color-ws-ink);
		font: inherit;
	}

	input:focus-visible,
	select:focus-visible {
		outline: none;
		box-shadow: var(--ws-focus-ring);
	}

	.range-input {
		width: 96px;
		accent-color: var(--color-ws-accent);
	}

	.number-input {
		width: 68px;
		height: 26px;
		padding: 0 6px;
		text-align: right;
	}

	.number-input-paired {
		width: 58px;
	}

	.toggle-input {
		width: 18px;
		height: 18px;
		margin: 0;
		accent-color: var(--color-ws-accent);
	}

	.select-input {
		height: 26px;
		min-width: 120px;
		max-width: 180px;
		padding: 0 24px 0 8px;
	}

	.select-input:disabled {
		color: var(--color-ws-faint);
		opacity: 0.7;
	}

	.option-control-color {
		position: relative;
	}

	.color-trigger {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 96px;
		height: 26px;
		padding: 0 7px;
		border: 1px solid color-mix(in srgb, var(--color-ws-line, #a6b7dc) 18%, transparent);
		border-radius: 7px;
		background: var(--color-ws-bg, #0b0b0f);
		color: var(--color-ws-ink, #ececf2);
		font: inherit;
		cursor: pointer;
	}

	.color-trigger:focus-visible {
		outline: none;
		box-shadow: var(--ws-focus-ring, 0 0 0 2px #0b0b0f, 0 0 0 4px #7c5cff);
	}

	.color-swatch {
		width: 16px;
		height: 16px;
		flex: 0 0 auto;
		border: 1px solid rgba(255, 255, 255, 0.34);
		border-radius: 5px;
	}

	.color-value {
		overflow: hidden;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
		font-size: 11px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.color-popover-anchor {
		position: absolute;
		top: calc(100% + 8px);
		left: 0;
		z-index: 50;
	}

	.empty-options {
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-ws-faint);
		font-size: 12px;
	}
</style>
