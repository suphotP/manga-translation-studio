<!-- ImportRemapDialog — JSON import remap/review modal. ws design system + shared Dialog atom (W3.4).
	Presentational + a11y reskin only; mapping/remap logic stays in the store. -->
<script lang="ts">
	import {
		buildJsonImportMappingRows,
		type JsonImportMappingRow,
		type JsonImportSourceOption,
	} from "$lib/project/import-json-remap.js";
	import { importRemapStore } from "$lib/stores/import-remap.svelte.ts";
	import Dialog from "$lib/components/ui/Dialog.svelte";
	import { _ } from "$lib/i18n";

	let query = $state("");
	let rows = $state<JsonImportMappingRow[]>([]);
	let lastRequestKey = $state("");

	let request = $derived(importRemapStore.request);
	let optionsById = $derived(new Map((request?.options ?? []).map((option) => [option.id, option])));
	let selectedCount = $derived(rows.filter((row) => row.sourceOptionId && optionsById.has(row.sourceOptionId)).length);
	let skippedCount = $derived(Math.max(0, rows.length - selectedCount));
	let outsideSourceCount = $derived((request?.options ?? []).filter((option) => sourceOptionOutsideProject(option)).length);
	let targetLanguageLabel = $derived((request?.targetLang ?? "LANG").toUpperCase());
	let normalizedQuery = $derived(query.trim().toLowerCase());
	let visibleRows = $derived(
		rows.filter((row) => {
			if (!normalizedQuery) return true;
			const source = row.sourceOptionId ? optionsById.get(row.sourceOptionId) : null;
			return `${targetPageLabel(row)} ${row.targetImageName} ${source ? sourceLabel(source) : ""} ${source ? sourceBaseDetail(source) : ""}`
				.toLowerCase()
				.includes(normalizedQuery);
		}),
	);

	$effect(() => {
		if (!request) {
			rows = [];
			lastRequestKey = "";
			query = "";
			return;
		}
		const targetPages = request.targetPages?.length
			? request.targetPages
			: [{ pageIndex: request.targetPageIndex, imageName: request.targetImageName ?? "" }];
		const key = [
			request.targetPageIndex,
			request.projectPageCount,
			targetPages.map((page) => `${page.pageIndex}:${page.imageName}:${page.originalName ?? ""}`).join("|"),
			request.options.map((option) => option.id).join("|"),
		].join("::");
		if (key === lastRequestKey) return;
		rows = buildJsonImportMappingRows(targetPages, request.options);
		lastRequestKey = key;
		query = "";
	});

	function selectedSource(row: JsonImportMappingRow): JsonImportSourceOption | null {
		return row.sourceOptionId ? optionsById.get(row.sourceOptionId) ?? null : null;
	}

	function sourceOptionOutsideProject(option: JsonImportSourceOption): boolean {
		const pageIndex = option.sourcePageIndex ?? (
			option.sourcePageNumber !== undefined ? option.sourcePageNumber - 1 : undefined
		);
		return Boolean(request && pageIndex !== undefined && pageIndex >= request.projectPageCount);
	}

	// Localize the source option's STRUCTURED identity (kind/pageNumber/displayName)
	// from the import-json-remap helper. The helper no longer emits any display text.
	function sourceLabel(option: JsonImportSourceOption): string {
		if (option.kind === "pageIndex" || option.kind === "pageNumber") {
			return $_("importRemap.sourceLabel", { values: { n: option.pageNumber ?? 0 } });
		}
		return option.displayName ?? "";
	}

	function sourceBaseDetail(option: JsonImportSourceOption): string {
		switch (option.kind) {
			case "pageIndex":
				return $_("importRemap.sourceDetailIndex", { values: { n: option.pageNumber ?? 0 } });
			case "pageNumber":
				return $_("importRemap.sourceDetailNumber", { values: { n: option.pageNumber ?? 0 } });
			default:
				return option.sourceImageName ?? option.sourceImagePath ?? option.displayName ?? "";
		}
	}

	function sourceDetail(option: JsonImportSourceOption): string {
		const base = sourceBaseDetail(option);
		if (!sourceOptionOutsideProject(option)) return base;
		return $_("importRemap.sourceDetailOutside", {
			values: { detail: base, count: request?.projectPageCount ?? 0 },
		});
	}

	// Localize the target-page label from its structured number/name (helper no
	// longer emits Thai). Pick originalName ?? imageName for the {name} suffix.
	function targetPageLabel(row: JsonImportMappingRow): string {
		return row.targetPageName
			? $_("importRemap.targetPageLabelNamed", { values: { n: row.targetPageNumber, name: row.targetPageName } })
			: $_("importRemap.targetPageLabel", { values: { n: row.targetPageNumber } });
	}

	function updateRowSource(rowId: string, sourceOptionId: string): void {
		rows = rows.map((row) =>
			row.id === rowId
				? {
					...row,
					sourceOptionId: sourceOptionId || null,
					reason: sourceOptionId ? row.reason : "unmapped",
				}
				: row,
		);
	}

	function resetOrder(): void {
		rows = rows.map((row) => ({
			...row,
			sourceOptionId: row.defaultSourceOptionId,
			reason: row.defaultSourceOptionId ? "order" : "unmapped",
		}));
	}

	function clearAll(): void {
		rows = rows.map((row) => ({
			...row,
			sourceOptionId: null,
			reason: "unmapped",
		}));
	}

	function applyMapping(): void {
		if (!selectedCount) return;
		importRemapStore.apply(rows.map((row) => ({
			targetPageIndex: row.targetPageIndex,
			sourceOptionId: row.sourceOptionId,
		})));
	}

	function textCountLabel(count: number | undefined): string {
		// $_() re-evaluated on each call → reactive (not frozen in a const).
		return $_("importRemap.textLayerCount", { values: { count: count ?? 0 } });
	}
</script>

<Dialog
	open={Boolean(request)}
	onClose={() => importRemapStore.cancel()}
	ariaLabelledby="import-remap-title"
	closeLabel={$_("importRemap.closeLabel")}
	size="lg"
	panelClass="import-remap-panel"
>
	{#snippet header()}
		<header class="import-remap-header">
			<div>
				<p class="import-remap-kicker">{$_("importRemap.kicker")}</p>
				<h2 id="import-remap-title">{$_("importRemap.title")}</h2>
				<p class="import-remap-target-scope" aria-label={$_("importRemap.targetScopeLabel")}>
					{$_("importRemap.targetScope", { values: { lang: targetLanguageLabel, count: request?.projectPageCount ?? 0 } })}
				</p>
			</div>
		</header>
	{/snippet}

	{#if request}
		<section class="import-remap-summary" aria-label={$_("importRemap.summaryLabel")}>
			<div>
				<strong>{request.options.length}</strong>
				<span>{$_("importRemap.sourcesInJson")}</span>
			</div>
			<div>
				<strong>{request.projectPageCount}</strong>
				<span>{$_("importRemap.pagesInChapter")}</span>
			</div>
			<div>
				<strong>{selectedCount}</strong>
				<span>{$_("importRemap.mapped")}</span>
			</div>
			<div class:warn={skippedCount > 0}>
				<strong>{skippedCount}</strong>
				<span>{$_("importRemap.skipped")}</span>
			</div>
		</section>

		<p class="import-remap-copy">
			{$_("importRemap.copy")}
		</p>
		{#if outsideSourceCount > 0}
			<p class="import-remap-warning">
				{$_("importRemap.warning", { values: { count: outsideSourceCount } })}
			</p>
		{/if}

		<div class="import-remap-tools">
			<input
				class="import-remap-search"
				type="search"
				bind:value={query}
				placeholder={$_("importRemap.searchPlaceholder")}
				aria-label={$_("importRemap.searchLabel")}
			/>
			<div class="tool-buttons">
				<button type="button" class="ws-btn-ghost ghost-button" onclick={resetOrder}>{$_("importRemap.resetByImage")}</button>
				<button type="button" class="ws-btn-ghost ghost-button" onclick={clearAll}>{$_("importRemap.skipAll")}</button>
			</div>
		</div>

		<div class="mapping-table" role="table" aria-label={$_("importRemap.tableLabel")}>
			<div class="mapping-head" role="row">
				<span role="columnheader">{$_("importRemap.colChapterPage")}</span>
				<span role="columnheader">{$_("importRemap.colJsonSource")}</span>
				<span role="columnheader">{$_("importRemap.colDetail")}</span>
			</div>
			<div class="mapping-scroll">
				{#each visibleRows as row (row.id)}
					<div class:unmapped={!row.sourceOptionId} class="mapping-row" role="row">
						<div class="target-cell" role="cell">
							<strong>{targetPageLabel(row)}</strong>
							<small>{row.targetImageName}</small>
						</div>
						<div class="source-select-cell" role="cell">
							<label>
								<span>{$_("importRemap.sourceSelectLabel")}</span>
								<select
									aria-label={$_("importRemap.sourceSelectFor", { values: { page: targetPageLabel(row) } })}
									value={row.sourceOptionId ?? ""}
									onchange={(event) => updateRowSource(row.id, (event.currentTarget as HTMLSelectElement).value)}
								>
									<option value="">{$_("importRemap.skipThisPage")}</option>
									{#each request.options as option (option.id)}
										<option value={option.id}>
											{$_("importRemap.optionLabel", { values: { label: sourceLabel(option), count: textCountLabel(option.entryCount) } })}
										</option>
									{/each}
								</select>
							</label>
						</div>
						<div class="source-detail-cell" role="cell">
							{#if selectedSource(row)}
								<strong>{sourceLabel(selectedSource(row)!)}</strong>
								<small>{sourceDetail(selectedSource(row)!)}</small>
								<em>{textCountLabel(selectedSource(row)?.entryCount)}</em>
							{:else}
								<strong>{$_("importRemap.skippedTitle")}</strong>
								<small>{$_("importRemap.skippedDetail")}</small>
							{/if}
						</div>
					</div>
				{/each}
				{#if !visibleRows.length}
					<div class="empty-state">{$_("importRemap.noMatchInSearch")}</div>
				{/if}
			</div>
		</div>
	{/if}

	{#snippet footer()}
		<button type="button" class="ws-btn-ghost ghost-button" onclick={() => importRemapStore.cancel()}>{$_("importRemap.cancel")}</button>
		{#if selectedCount}
			<button type="button" class="ws-dialog-btn ws-dialog-btn-primary" onclick={applyMapping}>
				{$_("importRemap.apply")}
			</button>
		{:else}
			<span class="ws-dialog-btn ws-dialog-btn-primary ws-dialog-receipt" aria-label={$_("importRemap.applyStatusLabel")}>
				{$_("importRemap.selectSourceFirst")}
			</span>
		{/if}
	{/snippet}
</Dialog>

<style>
	/* Match the shared dialog body rhythm while keeping this dense remap table scannable. */
	:global(.ws-dialog-panel.import-remap-panel .ws-dialog-body) {
		display: grid;
		gap: 14px;
		align-content: start;
	}

	.import-remap-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		padding: 18px 64px 14px 18px;
		border-bottom: 1px solid var(--ws-hair);
	}

	.import-remap-kicker,
	.import-remap-target-scope,
	.import-remap-copy,
	.import-remap-warning,
	.target-cell small,
	.source-detail-cell small,
	.source-detail-cell em,
	.import-remap-summary span {
		margin: 0;
		color: var(--color-ws-text);
	}

	.import-remap-kicker {
		margin-bottom: 4px;
		color: var(--color-ws-accent);
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	h2 {
		margin: 0;
		color: var(--color-ws-ink);
		font-size: 22px;
		font-weight: 800;
		line-height: 1.12;
	}

	.import-remap-target-scope {
		margin-top: 8px;
		font-size: 13px;
		font-weight: 800;
		line-height: 1.35;
	}

	.import-remap-copy {
		line-height: 1.45;
		font-size: 13px;
	}

	.import-remap-warning {
		padding: 10px 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 38%, var(--ws-hair));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-amber) 12%, var(--color-ws-surface));
		color: var(--color-ws-amber);
		font-size: 13px;
		line-height: 1.45;
	}

	.import-remap-summary {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 8px;
	}

	.import-remap-summary div {
		display: grid;
		gap: 2px;
		min-width: 0;
		padding: 10px 12px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-surface2) 72%, var(--color-ws-bg));
	}

	.import-remap-summary strong {
		color: var(--color-ws-ink);
		font-size: 20px;
	}

	.import-remap-summary .warn strong {
		color: var(--color-ws-amber);
	}

	.import-remap-summary span {
		font-size: 12px;
	}

	.import-remap-tools {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.ghost-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 40px;
		padding: 0 14px;
		border-radius: var(--radius-ws-ctrl, 10px);
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 800;
		cursor: pointer;
	}

	.import-remap-search,
	select {
		width: 100%;
		min-height: 40px;
		padding: 0 12px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2) 68%, var(--color-ws-bg));
		color: var(--color-ws-ink);
		font: inherit;
		font-size: 13px;
	}

	.import-remap-search:focus,
	select:focus {
		outline: none;
		border-color: var(--color-ws-accent);
		box-shadow: var(--ws-focus-ring);
	}

	.import-remap-search {
		min-width: 0;
	}

	.tool-buttons {
		display: flex;
		flex: 0 0 auto;
		gap: 8px;
	}

	.mapping-table {
		display: grid;
		grid-template-rows: auto minmax(220px, 48vh);
		min-height: 0;
		overflow: hidden;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-surface2) 64%, var(--color-ws-bg));
	}

	.mapping-head,
	.mapping-row {
		display: grid;
		grid-template-columns: minmax(170px, 0.8fr) minmax(240px, 1fr) minmax(180px, 0.9fr);
		gap: 12px;
		align-items: center;
	}

	.mapping-head {
		padding: 10px 14px;
		border-bottom: 1px solid var(--ws-hair);
		background: color-mix(in srgb, var(--color-ws-surface2) 80%, var(--color-ws-bg));
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 900;
	}

	.mapping-scroll {
		overflow: auto;
		min-height: 0;
		scrollbar-width: thin;
	}

	.mapping-row {
		min-height: 78px;
		padding: 12px 14px;
		border-bottom: 1px solid var(--ws-hair);
		background: color-mix(in srgb, var(--color-ws-surface) 78%, var(--color-ws-bg));
	}

	.mapping-row.unmapped {
		background: color-mix(in srgb, var(--color-ws-amber) 10%, var(--color-ws-surface));
	}

	.target-cell,
	.source-select-cell,
	.source-detail-cell {
		display: grid;
		gap: 5px;
		min-width: 0;
	}

	.target-cell strong,
	.source-detail-cell strong {
		color: var(--color-ws-ink);
	}

	.source-select-cell label {
		display: grid;
		gap: 5px;
		min-width: 0;
	}

	.source-select-cell span {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}

	.target-cell strong,
	.target-cell small,
	.source-detail-cell strong,
	.source-detail-cell small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.target-cell small,
	.source-detail-cell small {
		font-size: 12px;
	}

	.source-detail-cell em {
		font-style: normal;
		font-weight: 800;
		font-size: 12px;
	}

	.empty-state {
		padding: 24px;
		background: color-mix(in srgb, var(--color-ws-surface2) 70%, var(--color-ws-bg));
		color: var(--color-ws-text);
		text-align: center;
	}

	@media (max-width: 760px) {
		.import-remap-summary {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.import-remap-tools {
			align-items: stretch;
			flex-direction: column;
		}

		.tool-buttons {
			width: 100%;
		}

		.tool-buttons button {
			flex: 1;
		}

		.mapping-head {
			display: none;
		}

		.mapping-row {
			grid-template-columns: minmax(0, 1fr);
			align-items: stretch;
			gap: 10px;
			min-height: 0;
		}
	}
</style>
