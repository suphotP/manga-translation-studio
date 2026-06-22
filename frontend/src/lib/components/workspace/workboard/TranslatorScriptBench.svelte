<script lang="ts">
	import { _ } from "$lib/i18n";
	import type { PageTranslationHandoff, TranslationScriptSlot } from "$lib/types.js";
	import { signedAssetSrc, type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";

	interface TranslatorBenchPreview {
		pageLabel: string;
		imageName: string;
		previewUrl: string | null;
		previewParams: SignedAssetSrcParams | null;
	}

	type TranslatorScriptSlotView = TranslationScriptSlot & { placeholder: string };

	interface Props {
		currentPageLabel: string;
		currentPageLanguageLabel: string;
		currentPageTranslationHandoff: PageTranslationHandoff | null;
		translatorBenchPreview: TranslatorBenchPreview | null;
		translatorScriptSlots: TranslatorScriptSlotView[];
		translatedScriptCount: number;
		activeTranslatorScriptSlot: TranslatorScriptSlotView | null;
		translatorHandoffTitle: string;
		translatorHandoffDetail: string;
		onUpdateTranslatorHandoff: (status: "draft" | "needs_translation") => void;
		onSendTranslatorHandoff: () => void;
		onMoveActiveTranslatorScriptSlot: (event: MouseEvent) => void;
		onSelectTranslatorScriptSlot: (slotId: string) => void;
		onAddTranslatorScriptSlot: () => void;
		onUpdateTranslatorSlotLabel: (slot: TranslationScriptSlot, value: string) => void;
		onUpdateTranslatorDraft: (slot: TranslationScriptSlot, value: string) => void;
		onDeleteTranslatorScriptSlot: (slot: TranslationScriptSlot) => void;
	}

	let {
		currentPageLabel,
		currentPageLanguageLabel,
		currentPageTranslationHandoff,
		translatorBenchPreview,
		translatorScriptSlots,
		translatedScriptCount,
		activeTranslatorScriptSlot,
		translatorHandoffTitle,
		translatorHandoffDetail,
		onUpdateTranslatorHandoff,
		onSendTranslatorHandoff,
		onMoveActiveTranslatorScriptSlot,
		onSelectTranslatorScriptSlot,
		onAddTranslatorScriptSlot,
		onUpdateTranslatorSlotLabel,
		onUpdateTranslatorDraft,
		onDeleteTranslatorScriptSlot,
	}: Props = $props();
</script>

<section class="translator-script-bench ws-panel" aria-label={$_("translatorBench.regionLabel")}>
	<div class="translator-bench-head">
		<span>{$_("translatorBench.eyebrow")}</span>
		<strong>{$_("translatorBench.heading")}</strong>
		<small>{$_("translatorBench.subhead")}</small>
	</div>
	<div class="translator-handoff-card ws-panel-quiet" class:ready={currentPageTranslationHandoff?.status === "translated"}>
		<div>
			<span>{$_("translatorBench.handoffStatus")}</span>
			<strong>{translatorHandoffTitle}</strong>
			<small>{$_("translatorBench.handoffMeta", { values: { lang: currentPageLanguageLabel, page: currentPageLabel, translated: translatedScriptCount, total: translatorScriptSlots.length, detail: translatorHandoffDetail } })}</small>
		</div>
		<div class="translator-handoff-actions">
			{#if currentPageTranslationHandoff?.status === "translated"}
				<button type="button" class="ws-btn-ghost" onclick={() => onUpdateTranslatorHandoff("draft")}>{$_("translatorBench.backToEdit")}</button>
			{:else}
				{#if translatedScriptCount > 0}
					<button type="button" class="primary ws-grad-primary" onclick={onSendTranslatorHandoff}>{$_("translatorBench.sendForTypeset")}</button>
				{/if}
				<button type="button" class="ws-btn-ghost" onclick={() => onUpdateTranslatorHandoff("needs_translation")}>{$_("translatorBench.needsMoreTranslation")}</button>
			{/if}
		</div>
	</div>
	<div class="translator-bench-body">
		<div
			class="translator-page-preview ws-panel-quiet"
			class:placement-ready={Boolean(translatorBenchPreview?.previewUrl)}
			aria-label={$_("translatorBench.previewAria")}
		>
			<span>{translatorBenchPreview?.pageLabel ?? $_("translatorBench.noPage")}</span>
			{#if translatorBenchPreview?.previewUrl && translatorBenchPreview.previewParams}
				<img use:signedAssetSrc={translatorBenchPreview.previewParams} alt="" />
				<button
					type="button"
					class="translator-placement-target ws-btn-ghost"
					aria-label={$_("translatorBench.moveSlotAria", { values: { label: activeTranslatorScriptSlot?.label ?? $_("translatorBench.selectedSlotFallback") } })}
					onclick={onMoveActiveTranslatorScriptSlot}
				></button>
			{:else}
				<strong>{translatorBenchPreview?.imageName ?? $_("translatorBench.openPageFirst")}</strong>
			{/if}
			{#each translatorScriptSlots as slot (slot.id)}
				<button
					type="button"
					class="translation-pin"
					class:active={slot.id === activeTranslatorScriptSlot?.id}
					style={`--pin-x:${slot.x}%;--pin-y:${slot.y}%`}
					aria-label={$_("translatorBench.selectSlotPositionAria", { values: { label: slot.label } })}
					aria-pressed={slot.id === activeTranslatorScriptSlot?.id}
					onclick={(event) => {
						event.stopPropagation();
						onSelectTranslatorScriptSlot(slot.id);
					}}
				>
					{slot.label}
				</button>
			{/each}
		</div>
		<div class="translator-script-list" aria-label={$_("translatorBench.scriptListAria")}>
			<div class="translator-slot-toolbar">
				<p class="translator-placement-hint">
					{$_("translatorBench.placing")} <strong>{activeTranslatorScriptSlot?.label ?? $_("translatorBench.selectSlot")}</strong> · {$_("translatorBench.tapImageToMove")}
				</p>
				<button type="button" class="ws-btn-ghost" onclick={onAddTranslatorScriptSlot}>{$_("translatorBench.addSlot")}</button>
			</div>
			{#if translatorScriptSlots.length === 0}
				<div class="translator-script-empty ws-panel-quiet" aria-label={$_("translatorBench.emptyAria")}>
					<strong>{$_("translatorBench.emptyTitle")}</strong>
					<small>{$_("translatorBench.emptyHint")}</small>
				</div>
			{/if}
			{#each translatorScriptSlots as slot (slot.id)}
				<div class="translator-script-card ws-panel-quiet" class:active={slot.id === activeTranslatorScriptSlot?.id}>
					<div class="translator-slot-meta">
						<label class="translator-slot-name">
							<span>{$_("translatorBench.slotName")}</span>
							<input
								name={`translator-slot-label-${slot.id}`}
								aria-label={$_("translatorBench.slotNameAria", { values: { label: slot.label } })}
								value={slot.label}
								onfocus={() => onSelectTranslatorScriptSlot(slot.id)}
								oninput={(event) => onUpdateTranslatorSlotLabel(slot, (event.currentTarget as HTMLInputElement).value)}
							/>
						</label>
						<span class="translator-slot-position">{$_("translatorBench.slotPosition", { values: { x: slot.x, y: slot.y } })}</span>
						<button type="button" class="translator-slot-delete ws-btn-ghost" onclick={() => onDeleteTranslatorScriptSlot(slot)}>
							{$_("translatorBench.deleteSlot")}
						</button>
					</div>
					<label class="translator-script-text">
						<span>{$_("translatorBench.slotPositionLabel", { values: { label: slot.label, x: slot.x, y: slot.y } })}</span>
						<textarea
							name={`translator-script-${slot.id}`}
							aria-label={$_("translatorBench.slotTextAria", { values: { label: slot.label } })}
							value={slot.translatedText}
							placeholder={slot.placeholder}
							rows="3"
							onfocus={() => onSelectTranslatorScriptSlot(slot.id)}
							oninput={(event) => onUpdateTranslatorDraft(slot, (event.currentTarget as HTMLTextAreaElement).value)}
						></textarea>
					</label>
				</div>
			{/each}
		</div>
	</div>
</section>

<style>
	.translator-script-bench {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface) 86%, transparent);
		color: var(--color-ws-ink);
	}

	.translator-bench-head span,
	.translator-handoff-card span,
	.translator-page-preview > span,
	.translator-slot-name span,
	.translator-script-text span {
		color: var(--color-ws-violet);
	}

	.translator-bench-head strong,
	.translator-handoff-card strong,
	.translator-page-preview strong,
	.translator-script-empty strong {
		color: var(--color-ws-ink);
	}

	.translator-bench-head small,
	.translator-handoff-card small,
	.translator-script-empty small,
	.translator-placement-hint,
	.translator-slot-position {
		color: var(--color-ws-text);
	}

	.translator-handoff-card,
	.translator-page-preview,
	.translator-script-empty,
	.translator-script-card {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface2) 62%, transparent);
	}

	.translator-handoff-card.ready,
	.translator-script-card.active {
		border-color: color-mix(in srgb, var(--color-ws-green) 32%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 10%, var(--color-ws-surface) 90%);
	}

	.translation-pin {
		min-height: 36px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 42%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-accent) 18%, transparent);
		color: var(--color-ws-ink);
	}

	.translation-pin.active {
		border-color: color-mix(in srgb, var(--color-ws-green) 52%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 22%, transparent);
	}

	.translator-handoff-actions button,
	.translator-slot-toolbar button,
	.translator-slot-delete,
	.translator-placement-target {
		min-height: 38px;
		border-radius: var(--radius-ws-ctrl);
		border: 1px solid var(--ws-hair);
		color: var(--color-ws-ink);
		font-family: inherit;
	}

	.translator-handoff-actions button.primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 52%, transparent);
	}

	.translator-slot-name input,
	.translator-script-text textarea {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-bg) 48%, transparent);
		color: var(--color-ws-ink);
	}
</style>
