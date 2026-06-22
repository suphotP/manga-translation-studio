<script lang="ts">
	/**
	 * BulkLayerActions — extracted from LayersInspectorPanel.svelte (W0.7).
	 *
	 * Behavior-preserving multi-select toolbar that renders the bulk
	 * show/hide/lock/unlock buttons for the currently-visible image-layer
	 * scope. Orchestrator owns the scope filter and computes the four
	 * `can*` flags + the human-readable `scopeLabel`; this atom just
	 * renders the buttons (or an empty-state note) and forwards user
	 * intent through callback props.
	 */
	import { _ } from "$lib/i18n";
	import type { ImageLayerBulkAction } from "$lib/types.js";

	interface Props {
		scopeLabel: string;
		canShowAll: boolean;
		canHideAll: boolean;
		canLockAll: boolean;
		canUnlockAll: boolean;
		onApply: (action: ImageLayerBulkAction) => void;
	}

	let {
		scopeLabel,
		canShowAll,
		canHideAll,
		canLockAll,
		canUnlockAll,
		onApply,
	}: Props = $props();

	let hasAnyAction = $derived(canShowAll || canHideAll || canLockAll || canUnlockAll);
</script>

<div class="image-layer-bulk-row" aria-label={$_("bulkLayerActions.rowLabel", { values: { scope: scopeLabel } })}>
	{#if canShowAll}
		<button
			class="layer-action-btn"
			onclick={() => onApply("show-all")}
			title={$_("bulkLayerActions.showAllTitle")}
			aria-label={$_("bulkLayerActions.showLabel", { values: { scope: scopeLabel } })}
		>{$_("bulkLayerActions.show")}</button>
	{/if}
	{#if canHideAll}
		<button
			class="layer-action-btn"
			onclick={() => onApply("hide-all")}
			title={$_("bulkLayerActions.hideAllTitle")}
			aria-label={$_("bulkLayerActions.hideLabel", { values: { scope: scopeLabel } })}
		>{$_("bulkLayerActions.hide")}</button>
	{/if}
	{#if canLockAll}
		<button
			class="layer-action-btn"
			onclick={() => onApply("lock-all")}
			title={$_("bulkLayerActions.lockAllTitle")}
			aria-label={$_("bulkLayerActions.lockLabel", { values: { scope: scopeLabel } })}
		>{$_("bulkLayerActions.lock")}</button>
	{/if}
	{#if canUnlockAll}
		<button
			class="layer-action-btn"
			onclick={() => onApply("unlock-all")}
			title={$_("bulkLayerActions.unlockAllTitle")}
			aria-label={$_("bulkLayerActions.unlockLabel", { values: { scope: scopeLabel } })}
		>{$_("bulkLayerActions.unlock")}</button>
	{/if}
	{#if !hasAnyAction}
		<span class="image-layer-bulk-note">{$_("bulkLayerActions.noActions")}</span>
	{/if}
</div>

<style>
	/*
	 * `.image-layer-bulk-row`, `.image-layer-bulk-note`, and `.layer-action-btn`
	 * styles live in LayersInspectorPanel.svelte. The bulk-row + bulk-note
	 * selectors are wrapped with `:global()` in the parent so this atom can
	 * reuse them without duplicating visual rules. `.layer-action-btn` is
	 * already a shared global class used across the inspector.
	 */
</style>
