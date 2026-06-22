<script lang="ts">
	/**
	 * EffectsHost — extracted from LayersInspectorPanel.svelte (W0.3).
	 *
	 * Renders the "Effects" panel section header and body. Body either shows
	 * the existing EffectsPanel (when a text layer is selected) or a hint to
	 * pick a text layer first. Behavior-preserving: orchestrator owns
	 * `effectsOpen` state and the `hasSelectedTextLayer` flag.
	 */
	import { _ } from "$lib/i18n";
	import EffectsPanel from "../EffectsPanel.svelte";

	interface Props {
		effectsOpen: boolean;
		hasSelectedTextLayer: boolean;
		sectionToggleLabel: (label: string, open: boolean) => string;
		onToggleOpen: () => void;
	}

	let { effectsOpen, hasSelectedTextLayer, sectionToggleLabel, onToggleOpen }: Props = $props();
</script>

<div class="panel-section" id="effects-section">
	<button
		type="button"
		class="panel-section-header layers-section-header"
		aria-label={sectionToggleLabel($_("effectsHost.title"), effectsOpen)}
		aria-expanded={effectsOpen}
		onclick={onToggleOpen}
	>
		<span class="layers-section-copy">
			<span>{$_("effectsHost.title")}</span>
			<small>{hasSelectedTextLayer ? $_("effectsHost.subtitleReady") : $_("effectsHost.subtitleEmpty")}</small>
		</span>
		<span class="layers-section-meter">{hasSelectedTextLayer ? $_("effectsHost.meterReady") : $_("effectsHost.meterEmpty")}</span>
		<span class="layers-section-chevron" class:open={effectsOpen} aria-hidden="true"></span>
	</button>
	{#if effectsOpen}
		<div class="panel-section-body">
			{#if hasSelectedTextLayer}
				<EffectsPanel />
			{:else}
				<div style="color: var(--editor-text-dim); font-size: 11px; padding: 4px 0;">
					{$_("effectsHost.subtitleEmpty")}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	/*
	 * EffectsHost reuses the section header styles from the parent
	 * (.layers-section-copy, .layers-section-meter, .layers-section-chevron).
	 * Those styles live in LayersInspectorPanel.svelte and are exposed with
	 * :global() wrappers there so this child component can use them without
	 * duplicating the visual rules.
	 *
	 * `.panel-section`, `.panel-section-header`, `.panel-section-body` are
	 * already global in app.css.
	 */
</style>
