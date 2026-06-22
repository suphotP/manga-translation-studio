<!-- PageRelinkConfirmationDialog — order-fallback safety check. ws design system + shared Dialog atom (W3.4).
	Presentational + a11y reskin only; relink decision logic stays in the store. -->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import { buildPageImageRelinkOrderFallbackPreview } from "$lib/project/page-relink-confirmation.js";
	import { pageRelinkConfirmationStore } from "$lib/stores/page-relink-confirmation.svelte.ts";
	import Dialog from "$lib/components/ui/Dialog.svelte";

	let request = $derived(pageRelinkConfirmationStore.request);
	let preview = $derived(request ? buildPageImageRelinkOrderFallbackPreview(request.preview) : null);
</script>

<Dialog
	open={Boolean(request && preview)}
	onClose={() => pageRelinkConfirmationStore.cancel()}
	role="alertdialog"
	ariaLabelledby="page-relink-title"
	ariaDescribedby="page-relink-copy"
	closeLabel={$_("pageRelink.closeLabel")}
	size="lg"
	panelClass="page-relink-panel"
>
	{#snippet header()}
		<header class="page-relink-header">
			<div>
				<p class="page-relink-kicker">{$_("pageRelink.kicker")}</p>
				<h2 id="page-relink-title">{$_("pageRelink.title")}</h2>
			</div>
		</header>
	{/snippet}

	{#if request && preview}
		<section class="page-relink-summary" aria-label={$_("pageRelink.summaryLabel")}>
			<div>
				<strong>{preview.orderMatchedCount}</strong>
				<span>{$_("pageRelink.orderMatched")}</span>
			</div>
			<div>
				<strong>{preview.nameMatchedCount}</strong>
				<span>{$_("pageRelink.nameMatched")}</span>
			</div>
			<div class:warn={preview.unmatchedPageCount > 0}>
				<strong>{preview.unmatchedPageCount}</strong>
				<span>{$_("pageRelink.unmatchedPages")}</span>
			</div>
			<div class:warn={preview.unusedFileCount > 0}>
				<strong>{preview.unusedFileCount}</strong>
				<span>{$_("pageRelink.unusedFiles")}</span>
			</div>
		</section>

		<p id="page-relink-copy" class="page-relink-copy">
			{$_("pageRelink.copy")}
		</p>

		<div class="page-relink-table" role="table" aria-label={$_("pageRelink.tableLabel")}>
			<div class="page-relink-head" role="row">
				<span role="columnheader">{$_("pageRelink.colPage")}</span>
				<span role="columnheader">{$_("pageRelink.colFile")}</span>
				<span role="columnheader">{$_("pageRelink.colExpected")}</span>
			</div>
			<div class="page-relink-scroll">
				{#each preview.rows as row (row.pageIndex)}
					<div class="page-relink-row" role="row">
						<div role="cell"><strong>{row.pageLabel}</strong></div>
						<div role="cell"><span>{row.fileName}</span></div>
						<div role="cell"><small>{row.expectedName}</small></div>
					</div>
				{/each}
				{#if preview.hiddenRowCount > 0}
					<div class="page-relink-more">
						{$_("pageRelink.hiddenRows", { values: { count: preview.hiddenRowCount } })}
					</div>
				{/if}
			</div>
		</div>

		{#if preview.unsupportedSummary}
			<p class="page-relink-warning">{preview.unsupportedSummary}</p>
		{/if}
	{/if}

	{#snippet footer()}
		<button type="button" class="ws-btn-ghost ws-dialog-btn" onclick={() => pageRelinkConfirmationStore.cancel()}>
			{$_("pageRelink.cancel")}
		</button>
		<button type="button" class="ws-dialog-btn ws-dialog-btn-primary" onclick={() => pageRelinkConfirmationStore.confirm()}>
			{$_("pageRelink.confirm")}
		</button>
	{/snippet}
</Dialog>

<style>
	:global(.ws-dialog-panel.page-relink-panel .ws-dialog-body) {
		display: grid;
		gap: 14px;
		align-content: start;
	}

	.page-relink-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		padding: 18px 64px 14px 18px;
		border-bottom: 1px solid var(--ws-hair);
	}

	.page-relink-kicker {
		margin: 0 0 4px;
		color: var(--color-ws-accent);
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	h2 {
		margin: 0;
		color: var(--color-ws-ink);
		font-size: 20px;
		font-weight: 800;
		line-height: 1.25;
	}

	.page-relink-summary {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 10px;
	}

	.page-relink-summary div {
		display: grid;
		gap: 2px;
		min-width: 0;
		padding: 10px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-surface2) 72%, var(--color-ws-bg));
	}

	.page-relink-summary .warn {
		border-color: color-mix(in srgb, var(--color-ws-amber) 42%, var(--ws-hair));
		background: color-mix(in srgb, var(--color-ws-amber) 12%, var(--color-ws-surface));
	}

	.page-relink-summary strong {
		color: var(--color-ws-ink);
		font-size: 20px;
		line-height: 1;
	}

	.page-relink-summary span,
	.page-relink-copy,
	.page-relink-row small,
	.page-relink-more,
	.page-relink-warning {
		color: var(--color-ws-text);
		font-size: 13px;
		line-height: 1.45;
	}

	.page-relink-copy,
	.page-relink-warning {
		margin: 0;
	}

	.page-relink-table {
		display: grid;
		grid-template-rows: auto 1fr;
		min-height: 0;
		overflow: hidden;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-surface2) 64%, var(--color-ws-bg));
	}

	.page-relink-head,
	.page-relink-row {
		display: grid;
		grid-template-columns: minmax(92px, 0.7fr) minmax(150px, 1.4fr) minmax(130px, 1fr);
		gap: 10px;
		align-items: center;
	}

	.page-relink-head {
		padding: 10px 12px;
		border-bottom: 1px solid var(--ws-hair);
		background: color-mix(in srgb, var(--color-ws-surface2) 80%, var(--color-ws-bg));
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 800;
		text-transform: uppercase;
	}

	.page-relink-scroll {
		max-height: min(320px, 36vh);
		overflow: auto;
		scrollbar-width: thin;
	}

	.page-relink-row {
		min-height: 44px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--ws-hair);
		background: color-mix(in srgb, var(--color-ws-surface) 78%, var(--color-ws-bg));
	}

	.page-relink-row strong {
		color: var(--color-ws-ink);
	}

	.page-relink-row span,
	.page-relink-row small {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.page-relink-more {
		padding: 12px;
		background: color-mix(in srgb, var(--color-ws-surface2) 70%, var(--color-ws-bg));
	}

	.page-relink-warning {
		padding: 10px 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 38%, var(--ws-hair));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-amber) 12%, var(--color-ws-surface));
		color: var(--color-ws-amber);
	}

	@media (max-width: 720px) {
		.page-relink-summary {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.page-relink-head {
			display: none;
		}

		.page-relink-row {
			grid-template-columns: 1fr;
			gap: 4px;
			align-items: start;
			min-height: 72px;
		}
	}
</style>
