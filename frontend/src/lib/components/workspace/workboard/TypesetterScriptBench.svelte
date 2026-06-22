<script lang="ts">
	import { _ } from "$lib/i18n";
	import type { PageCleaningHandoff, TextLayer, TranslationScriptSlot } from "$lib/types.js";

	type TranslatorScriptSlotView = TranslationScriptSlot & { placeholder: string };
	type TranslationSlotLayerSyncState = "synced" | "stale";

	interface Props {
		currentPageLabel: string;
		currentPageLanguageLabel: string;
		currentPageCleaningHandoff: PageCleaningHandoff | null;
		translatorScriptSlots: TranslatorScriptSlotView[];
		currentPageOrphanedTypesetLayers: TextLayer[];
		typesetterCleanReadinessTone: "ready" | "warn" | "raw";
		typesetterCleanReadinessTitle: string;
		typesetterCleanReadinessDetail: string;
		textLayerForTranslationSlot: (slot: TranslationScriptSlot) => TextLayer | null;
		translationSlotLayerSyncState: (slot: TranslationScriptSlot, layer: TextLayer) => TranslationSlotLayerSyncState;
		translationSlotLayerSyncLabel: (state: TranslationSlotLayerSyncState) => string;
		translationSlotCleanContextLabel: (existingTextLayer: TextLayer | null) => string;
		typesetLayerOpenActionLabel: string;
		typesetLayerCreateActionLabel: string;
		typesetLayerOpenActionAria: (slotOrLayer: TranslationScriptSlot | TextLayer) => string;
		typesetLayerCreateActionAria: (slot: TranslationScriptSlot) => string;
		onSelectCleaner: () => void;
		onUpdateTextLayerFromTranslationSlot: (slot: TranslationScriptSlot) => void;
		onOpenTextLayerInEditor: (layerId: string) => void;
		onCreateTextLayerFromTranslationSlot: (slot: TranslationScriptSlot) => void;
		onUnlinkOrphanTypesetLayer: (layer: TextLayer) => void;
	}

	let {
		currentPageLabel,
		currentPageLanguageLabel,
		currentPageCleaningHandoff,
		translatorScriptSlots,
		currentPageOrphanedTypesetLayers,
		typesetterCleanReadinessTone,
		typesetterCleanReadinessTitle,
		typesetterCleanReadinessDetail,
		textLayerForTranslationSlot,
		translationSlotLayerSyncState,
		translationSlotLayerSyncLabel,
		translationSlotCleanContextLabel,
		typesetLayerOpenActionLabel,
		typesetLayerCreateActionLabel,
		typesetLayerOpenActionAria,
		typesetLayerCreateActionAria,
		onSelectCleaner,
		onUpdateTextLayerFromTranslationSlot,
		onOpenTextLayerInEditor,
		onCreateTextLayerFromTranslationSlot,
		onUnlinkOrphanTypesetLayer,
	}: Props = $props();
</script>

<section class="typesetter-script-bench ws-panel" aria-label={$_("typesetterBench.regionLabel")}>
	<div class="typesetter-bench-head">
		<span>{$_("typesetterBench.role")}</span>
		<strong>{currentPageLabel} / {currentPageLanguageLabel} · {currentPageCleaningHandoff?.status === "clean_ready" ? $_("typesetterBench.cleanReady") : $_("typesetterBench.startOnRaw")}</strong>
		<small>{$_("typesetterBench.headHint")}</small>
	</div>
	<div class={`typesetter-clean-readiness ws-panel-quiet ${typesetterCleanReadinessTone}`} aria-label={$_("typesetterBench.cleanStatusLabel")}>
		<div>
			<span>{$_("typesetterBench.imageForTypeset")}</span>
			<strong>{typesetterCleanReadinessTitle}</strong>
			<small>{typesetterCleanReadinessDetail}</small>
		</div>
		{#if currentPageCleaningHandoff?.status !== "clean_ready"}
			<button type="button" class="ws-btn-ghost" onclick={onSelectCleaner}>{$_("typesetterBench.viewCleanStatus")}</button>
		{/if}
	</div>
	<div class="typesetter-script-list">
		{#if translatorScriptSlots.length === 0 && currentPageOrphanedTypesetLayers.length === 0}
			<div class="typesetter-script-empty ws-panel-quiet" aria-label={$_("typesetterBench.emptyLabel")}>
				<strong>{$_("typesetterBench.emptyTitle")}</strong>
				<small>{$_("typesetterBench.emptyHint")}</small>
			</div>
		{/if}
		{#each translatorScriptSlots as slot (slot.id)}
			{@const existingTextLayer = textLayerForTranslationSlot(slot)}
			{@const syncState = existingTextLayer ? translationSlotLayerSyncState(slot, existingTextLayer) : null}
			<div class="typesetter-script-card ws-panel-quiet" class:ready={Boolean(slot.translatedText.trim())} class:done={existingTextLayer} class:stale={syncState === "stale"}>
				<div>
					<span>{slot.label} {$_("typesetterBench.position", { values: { x: slot.x, y: slot.y } })}</span>
					<strong>{slot.translatedText.trim() || $_("typesetterBench.awaitingTranslation")}</strong>
					{#if syncState}
						<small class={`typesetter-sync-note ${syncState}`}>{translationSlotLayerSyncLabel(syncState)}</small>
					{/if}
					<small class="typesetter-clean-note">{translationSlotCleanContextLabel(existingTextLayer)}</small>
				</div>
				{#if existingTextLayer}
					<div class="typesetter-script-actions">
						{#if syncState === "stale"}
							<button type="button" class="primary ws-grad-primary" onclick={() => onUpdateTextLayerFromTranslationSlot(slot)}>{$_("typesetterBench.updateTextBox")}</button>
						{/if}
						<button type="button" class="ws-btn-ghost" aria-label={typesetLayerOpenActionAria(slot)} onclick={() => onOpenTextLayerInEditor(existingTextLayer.id)}>{typesetLayerOpenActionLabel}</button>
					</div>
				{:else if slot.translatedText.trim()}
					<div class="typesetter-script-actions">
						<button type="button" class="primary ws-grad-primary" aria-label={typesetLayerCreateActionAria(slot)} onclick={() => onCreateTextLayerFromTranslationSlot(slot)}>{typesetLayerCreateActionLabel}</button>
					</div>
				{:else}
					<em>{$_("typesetterBench.writeTranslationFirst")}</em>
				{/if}
			</div>
		{/each}
		{#if currentPageOrphanedTypesetLayers.length}
			<div class="typesetter-orphan-group ws-panel-quiet" role="region" aria-label={$_("typesetterBench.orphanRegionLabel")}>
				<div class="typesetter-orphan-head">
					<span>{$_("typesetterBench.orphanHead")}</span>
					<strong>{$_("typesetterBench.orphanCount", { values: { n: currentPageOrphanedTypesetLayers.length } })}</strong>
					<small>{$_("typesetterBench.orphanHint")}</small>
				</div>
				{#each currentPageOrphanedTypesetLayers as layer (layer.id)}
					<div class="typesetter-script-card orphan ws-panel-quiet">
						<div>
							<span>{layer.name || layer.id}</span>
							<strong>{layer.text}</strong>
							<small class="typesetter-sync-note stale">{$_("typesetterBench.orphanSourceDeleted")}</small>
							<small class="typesetter-clean-note">{translationSlotCleanContextLabel(layer)}</small>
						</div>
						<div class="typesetter-script-actions">
							<button type="button" class="primary ws-grad-primary" aria-label={typesetLayerOpenActionAria(layer)} onclick={() => onOpenTextLayerInEditor(layer.id)}>{typesetLayerOpenActionLabel}</button>
							<button type="button" class="ws-btn-ghost" onclick={() => onUnlinkOrphanTypesetLayer(layer)}>{$_("typesetterBench.keepStandalone")}</button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</section>

<style>
	.typesetter-script-bench {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface) 86%, transparent);
		color: var(--color-ws-ink);
	}

	.typesetter-bench-head span,
	.typesetter-clean-readiness span,
	.typesetter-script-card span,
	.typesetter-orphan-head span {
		color: var(--color-ws-violet);
	}

	.typesetter-bench-head strong,
	.typesetter-clean-readiness strong,
	.typesetter-script-empty strong,
	.typesetter-script-card strong,
	.typesetter-orphan-head strong {
		color: var(--color-ws-ink);
	}

	.typesetter-bench-head small,
	.typesetter-clean-readiness small,
	.typesetter-script-empty small,
	.typesetter-clean-note,
	.typesetter-orphan-head small {
		color: var(--color-ws-text);
	}

	.typesetter-clean-readiness,
	.typesetter-script-empty,
	.typesetter-script-card,
	.typesetter-orphan-group {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface2) 62%, transparent);
	}

	.typesetter-clean-readiness.ready,
	.typesetter-script-card.done {
		border-color: color-mix(in srgb, var(--color-ws-green) 32%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 10%, var(--color-ws-surface) 90%);
	}

	.typesetter-clean-readiness.warn,
	.typesetter-script-card.stale,
	.typesetter-script-card.orphan {
		border-color: color-mix(in srgb, var(--color-ws-amber) 32%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 10%, var(--color-ws-surface) 90%);
	}

	.typesetter-sync-note {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 70%, transparent);
		color: var(--color-ws-text);
	}

	.typesetter-sync-note.synced {
		border-color: color-mix(in srgb, var(--color-ws-green) 30%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 12%, transparent);
		color: var(--color-ws-green);
	}

	.typesetter-sync-note.stale {
		border-color: color-mix(in srgb, var(--color-ws-amber) 32%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 12%, transparent);
		color: var(--color-ws-amber);
	}

	.typesetter-clean-readiness button,
	.typesetter-script-actions button {
		min-height: 38px;
		border-radius: var(--radius-ws-ctrl);
		border: 1px solid var(--ws-hair);
		color: var(--color-ws-ink);
		font-family: inherit;
	}

	.typesetter-script-actions button.primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 52%, transparent);
	}
</style>
