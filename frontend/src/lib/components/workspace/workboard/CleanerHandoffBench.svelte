<script lang="ts">
	import { _ } from "$lib/i18n";
	import type { ImageLayer, PageCleaningHandoff } from "$lib/types.js";

	interface Props {
		currentPageLabel: string;
		currentPageName: string;
		currentPageCleaningHandoff: PageCleaningHandoff | null;
		currentPageCleanBrushProof: ImageLayer | null;
		cleanHandoffImpactTitle: string;
		cleanHandoffImpactDetail: string;
		cleanHandoffProofLabel: string;
		onMarkCleanReady: (proofKind: "brush-edited-layer" | "no-clean-needed") => void;
		onMarkNeedsClean: () => void;
		/** External-clean roundtrip (optional — absent hides the section). */
		cleanRoundtripBusy?: boolean;
		onExportOriginals?: (scope: "current" | "all") => void;
		onImportCleaned?: (files: File[]) => void;
	}

	let {
		currentPageLabel,
		currentPageName,
		currentPageCleaningHandoff,
		currentPageCleanBrushProof,
		cleanHandoffImpactTitle,
		cleanHandoffImpactDetail,
		cleanHandoffProofLabel,
		onMarkCleanReady,
		onMarkNeedsClean,
		cleanRoundtripBusy = false,
		onExportOriginals,
		onImportCleaned,
	}: Props = $props();

	let importInput: HTMLInputElement | null = $state(null);

	function handleImportPick(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		input.value = "";
		if (files.length) onImportCleaned?.(files);
	}
</script>

<section class="cleaner-handoff-bench ws-panel" aria-label={$_("cleanerHandoffBench.regionLabel")}>
	<div class="cleaner-handoff-copy">
		<span>{$_("cleanerHandoffBench.role")}</span>
		<strong>{currentPageLabel} · {currentPageName}</strong>
		<small>{$_("cleanerHandoffBench.roleHint")}</small>
	</div>
	<div class="cleaner-handoff-status ws-panel-quiet" class:ready={currentPageCleaningHandoff?.status === "clean_ready"}>
		<span>{currentPageCleaningHandoff?.status === "clean_ready" ? $_("cleanerHandoffBench.statusCleanReady") : $_("cleanerHandoffBench.statusRaw")}</span>
		<small>{currentPageCleaningHandoff?.updatedAt ? $_("cleanerHandoffBench.updatedAt", { values: { time: new Date(currentPageCleaningHandoff.updatedAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) } }) : $_("cleanerHandoffBench.notSent")}</small>
		<em class:ready={currentPageCleaningHandoff?.status === "clean_ready"}>{cleanHandoffProofLabel}</em>
	</div>
	<div class="cleaner-handoff-impact ws-panel-quiet" class:ready={currentPageCleaningHandoff?.status === "clean_ready"}>
		<span>{$_("cleanerHandoffBench.impactLabel")}</span>
		<strong>{cleanHandoffImpactTitle}</strong>
		<small>{cleanHandoffImpactDetail}</small>
	</div>
	<div class="cleaner-handoff-actions">
		{#if currentPageCleaningHandoff?.status === "clean_ready"}
			<button type="button" class="ws-btn-ghost" onclick={onMarkNeedsClean}>{$_("cleanerHandoffBench.backToFixClean")}</button>
		{:else if currentPageCleanBrushProof}
			<button type="button" class="primary ws-grad-primary" onclick={() => onMarkCleanReady("brush-edited-layer")}>{$_("cleanerHandoffBench.sendWithBrushProof")}</button>
		{:else}
			<button type="button" class="ws-btn-ghost" onclick={() => onMarkCleanReady("no-clean-needed")}>{$_("cleanerHandoffBench.confirmNoClean")}</button>
		{/if}
	</div>
	{#if onExportOriginals && onImportCleaned}
		<div class="cleaner-roundtrip ws-panel-quiet" role="group" aria-label={$_("cleanerHandoffBench.roundtripAria")}>
			<span>{$_("cleanerHandoffBench.roundtripLabel")}</span>
			<div class="cleaner-roundtrip-actions">
				<button type="button" class="ws-btn-ghost" disabled={cleanRoundtripBusy} onclick={() => onExportOriginals?.("current")}>{$_("cleanerHandoffBench.exportCurrent")}</button>
				<button type="button" class="ws-btn-ghost" disabled={cleanRoundtripBusy} onclick={() => onExportOriginals?.("all")}>{$_("cleanerHandoffBench.exportAll")}</button>
				<button type="button" class="primary ws-grad-primary" disabled={cleanRoundtripBusy} onclick={() => importInput?.click()}>{$_("cleanerHandoffBench.importCleaned")}</button>
				<input
					type="file"
					accept="image/png,image/jpeg,image/webp"
					multiple
					hidden
					bind:this={importInput}
					onchange={handleImportPick}
					aria-label={$_("cleanerHandoffBench.importCleanedAria")}
				/>
			</div>
			<small>{$_("cleanerHandoffBench.roundtripDimensionNote")}</small>
		</div>
	{/if}
</section>

<style>
	.cleaner-handoff-bench {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface) 86%, transparent);
		color: var(--color-ws-ink);
	}

	.cleaner-handoff-copy span,
	.cleaner-handoff-status span,
	.cleaner-handoff-impact span,
	.cleaner-roundtrip > span {
		color: var(--color-ws-violet);
	}

	.cleaner-handoff-copy strong,
	.cleaner-handoff-impact strong {
		color: var(--color-ws-ink);
	}

	.cleaner-handoff-copy small,
	.cleaner-handoff-status small,
	.cleaner-handoff-impact small,
	.cleaner-roundtrip small {
		color: var(--color-ws-text);
	}

	.cleaner-handoff-status,
	.cleaner-handoff-impact,
	.cleaner-roundtrip {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface2) 62%, transparent);
	}

	.cleaner-handoff-status.ready,
	.cleaner-handoff-impact.ready {
		border-color: color-mix(in srgb, var(--color-ws-green) 32%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 10%, var(--color-ws-surface) 90%);
	}

	.cleaner-handoff-status em {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 70%, transparent);
		color: var(--color-ws-text);
	}

	.cleaner-handoff-status em.ready {
		border-color: color-mix(in srgb, var(--color-ws-green) 30%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 12%, transparent);
		color: var(--color-ws-green);
	}

	.cleaner-handoff-actions button,
	.cleaner-roundtrip-actions button {
		min-height: 38px;
		border-radius: var(--radius-ws-ctrl);
		border: 1px solid var(--ws-hair);
		color: var(--color-ws-ink);
		font-family: inherit;
	}

	.cleaner-handoff-actions button.primary,
	.cleaner-roundtrip-actions button.primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 52%, transparent);
	}
</style>
