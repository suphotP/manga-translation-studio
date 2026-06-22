<!-- CropRatioPicker — aspect-ratio picker for the crop / selection tool.
	W3.1: relocated OUT of the old "select" options context INTO the top context
	bar, shown only when the Crop tool is active. Controlled component: the caller
	owns the active value + the ratio map and reacts via onSelect. It never touches
	the Fabric engine directly. -->
<script lang="ts">
	import { _ } from "$lib/i18n";

	let {
		ratios,
		active,
		onSelect,
	}: {
		/** Display label -> [w, h] | null (null = free / fit width). */
		ratios: Record<string, [number, number] | null>;
		/** Currently selected ratio label. */
		active: string;
		/** Called with the chosen label. */
		onSelect: (label: string) => void;
	} = $props();

	let entries = $derived(Object.keys(ratios));

	function shortLabel(label: string): string {
		// "1:1 Square" -> "1:1", "Fit Width" -> "Free"
		const ratio = ratios[label];
		if (!ratio) return "Free";
		return `${ratio[0]}:${ratio[1]}`;
	}
</script>

<div class="crop-ratio-picker" role="radiogroup" aria-label={$_("cropRatioPicker.groupLabel")}>
	<span class="crop-ratio-label">{$_("cropRatioPicker.label")}</span>
	<div class="crop-ratio-chips">
		{#each entries as label (label)}
			<button
				type="button"
				role="radio"
				class="crop-ratio-chip"
				class:active={active === label}
				aria-checked={active === label}
				title={label}
				onclick={() => onSelect(label)}
			>
				{shortLabel(label)}
			</button>
		{/each}
	</div>
</div>

<style>
	.crop-ratio-picker {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.crop-ratio-label {
		flex: 0 0 auto;
		color: var(--color-ws-text, rgba(251, 247, 255, 0.6));
		font-size: 11px;
		font-weight: 700;
		white-space: nowrap;
	}

	.crop-ratio-chips {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}

	.crop-ratio-chip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 32px;
		min-width: 40px;
		padding: 0 10px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.035);
		color: rgba(251, 247, 255, 0.74);
		font-size: 11px;
		font-weight: 800;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.2px;
		white-space: nowrap;
		cursor: pointer;
		transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
	}

	.crop-ratio-chip:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 35%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 10%, transparent);
		color: var(--color-ws-ink, #ececf2);
	}

	.crop-ratio-chip:focus-visible {
		outline: none;
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 60%, transparent);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-ws-accent, #7c5cff) 30%, transparent);
	}

	.crop-ratio-chip.active {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 50%, transparent);
		background: linear-gradient(180deg, color-mix(in srgb, var(--color-ws-accent, #7c5cff) 24%, transparent), rgba(217, 70, 239, 0.12));
		color: #f2ecff;
		box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--color-ws-accent, #7c5cff) 34%, transparent);
	}
</style>
