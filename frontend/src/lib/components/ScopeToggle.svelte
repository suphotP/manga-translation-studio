<script lang="ts">
	import { _ } from "$lib/i18n";

	type ScopeToggleValue = "page" | "all";

	interface Props {
		label: string;
		value: ScopeToggleValue;
		pageLabel?: string;
		allLabel?: string;
		disabled?: boolean;
		onChange: (value: ScopeToggleValue) => void;
	}

	let {
		label,
		value,
		pageLabel = undefined,
		allLabel = undefined,
		disabled = false,
		onChange,
	}: Props = $props();

	// Localized fallbacks for the scope option labels when the caller omits them.
	let pageLabelText = $derived(pageLabel ?? $_("scopeToggle.page"));
	let allLabelText = $derived(allLabel ?? $_("scopeToggle.all"));
</script>

<div class="scope-toggle" role="group" aria-label={label}>
	{#if disabled}
		<span class="scope-toggle-option scope-toggle-receipt" class:active={value === "page"}>
			{pageLabelText}
		</span>
		<span class="scope-toggle-option scope-toggle-receipt" class:active={value === "all"}>
			{allLabelText}
		</span>
	{:else}
		<button
			type="button"
			class="scope-toggle-option"
			class:active={value === "page"}
			aria-pressed={value === "page"}
			onclick={() => onChange("page")}
		>
			{pageLabelText}
		</button>
		<button
			type="button"
			class="scope-toggle-option"
			class:active={value === "all"}
			aria-pressed={value === "all"}
			onclick={() => onChange("all")}
		>
			{allLabelText}
		</button>
	{/if}
</div>

<style>
	.scope-toggle {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 4px;
	}

	.scope-toggle-option {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 40px;
		border: 1px solid var(--editor-border);
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.035);
		color: var(--editor-text-dim);
		font-size: 10px;
		font-weight: 800;
		cursor: pointer;
	}

	.scope-toggle button:hover {
		border-color: rgba(0, 120, 212, 0.5);
		color: var(--editor-text);
	}

	.scope-toggle-option.active {
		border-color: rgba(80, 190, 255, 0.72);
		background: rgba(0, 120, 212, 0.18);
		color: #d9efff;
	}

	.scope-toggle-receipt {
		opacity: 0.42;
		cursor: default;
	}

	@media (min-width: 861px) and (max-width: 1040px) {
		.scope-toggle-option {
			min-height: 40px;
			padding: 0 10px;
			font-size: 11px;
		}
	}
</style>
