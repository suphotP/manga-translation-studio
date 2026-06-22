<script lang="ts">
	/**
	 * AssetBrowser — extracted from LayersInspectorPanel.svelte (W0.7).
	 *
	 * Renders the collapsible "คลังรูป" drawer, the reusable asset list
	 * (list or grid view), the show-more row, the empty-state hint, and
	 * the selected-asset detail card.
	 *
	 * Behavior-preserving. The orchestrator continues to own:
	 *   - which assets are visible/filtered
	 *   - which view mode is active (list/grid)
	 *   - the selected asset id and replacement-mode flags
	 *   - thumbnail/preview load-failure caches (so retries survive a
	 *     parent re-render)
	 *
	 * Per-asset display + URL/state helpers are passed in as callbacks
	 * so this atom stays purely presentational.
	 */
	import type { ProjectImageAssetSummary, StorageQuotaSummary } from "$lib/api/client.js";
	import { thumbnailUrl } from "$lib/api/client.js";
	import { signedAssetSrc, type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";
	import type { ImageLayer } from "$lib/types.js";
	import { _ } from "$lib/i18n/index.ts";
	import type { Snippet } from "svelte";

	type ImageAssetViewMode = "list" | "grid";
	type AssetSizeBand = "all" | "lt500k" | "500kto2m" | "gt2m";
	type AssetSourceFilter = "all" | "uploaded" | "ai";
	type AssetDeleteOutcome =
		| { ok: true; freedBytes: number }
		| { referencedByPages: number[] }
		| { error: string };

	interface Props {
		drawerOpen: boolean;
		betweenDrawerAndList?: Snippet;
		projectId: string | null;
		imageAssets: ProjectImageAssetSummary[];
		filteredImageAssets: ProjectImageAssetSummary[];
		visibleImageAssets: ProjectImageAssetSummary[];
		selectedImageAsset: ProjectImageAssetSummary | null;
		selectedImageAssetId: string;
		selectedImageAssetVisible: boolean;
		imageAssetsLoading: boolean;
		imageAssetView: ImageAssetViewMode;
		imageAssetQuery: string;
		imageAssetSizeBand: AssetSizeBand;
		imageAssetSourceFilter: AssetSourceFilter;
		imageAssetStorageQuota: StorageQuotaSummary | null;
		deletingImageAssetId: string | null;
		canDeleteImageAssets: boolean;
		imageAssetBrowserExpanded: boolean;
		hiddenImageAssetCount: number;
		compactLimit: number;
		assetFilterInputId: string;
		hasImage: boolean;
		canFilterImageAssets: boolean;
		canSelectImageAsset: boolean;
		canUseSelectedImageAsset: boolean;
		canReplaceSelectedLayerFromAsset: boolean;
		selectedImageLayer: ImageLayer | null;
		selectedImageLayerIsAiResult: boolean;
		selectedImageReplacementMode: boolean;
		imageLayerDisplayName: (layer: ImageLayer) => string;
		formatAssetDisplayName: (asset: ProjectImageAssetSummary) => string;
		formatAssetShortId: (asset: ProjectImageAssetSummary) => string;
		formatAssetOptionLabel: (asset: ProjectImageAssetSummary) => string;
		formatAssetCompactBytes: (sizeBytes: number) => string;
		formatAssetBytes: (sizeBytes: number) => string;
		formatAssetDate: (value: string) => string;
		formatImageAssetUsageLabel: (asset: ProjectImageAssetSummary) => string;
		formatImageAssetReadyStatus: (asset: ProjectImageAssetSummary) => string;
		formatImageAssetFileType: (asset: ProjectImageAssetSummary) => string;
		getImageAssetUsageCount: (asset: ProjectImageAssetSummary) => number;
		shouldShowImageAssetThumbnail: (asset: ProjectImageAssetSummary) => boolean;
		shouldShowImageAssetPreview: (asset: ProjectImageAssetSummary) => boolean;
		imageAssetPreviewUrl: (asset: ProjectImageAssetSummary) => string;
		clearImageAssetThumbnailFailure: (asset: ProjectImageAssetSummary) => void;
		markImageAssetThumbnailFailed: (asset: ProjectImageAssetSummary) => void;
		clearImageAssetPreviewFailure: (asset: ProjectImageAssetSummary) => void;
		markImageAssetPreviewFailed: (asset: ProjectImageAssetSummary) => void;
		onToggleDrawer: (event: MouseEvent) => void;
		onImageAssetQueryChange: (event: Event) => void;
		onSetImageAssetSizeBand: (band: AssetSizeBand) => void;
		onSetImageAssetSourceFilter: (source: AssetSourceFilter) => void;
		onDeleteImageAsset: (asset: ProjectImageAssetSummary, force: boolean) => Promise<AssetDeleteOutcome>;
		onSetImageAssetView: (mode: ImageAssetViewMode) => void;
		onImageAssetSelectionChange: (event: Event) => void;
		onSelectImageAsset: (assetId: string) => void;
		onAddSelectedImageAssetLayer: () => void | Promise<void>;
		onReplaceSelectedImageLayerFromAsset: () => void | Promise<void>;
		onToggleImageAssetBrowserExpanded: () => void;
	}

	let {
		drawerOpen,
		betweenDrawerAndList,
		projectId,
		imageAssets,
		filteredImageAssets,
		visibleImageAssets,
		selectedImageAsset,
		selectedImageAssetId,
		selectedImageAssetVisible,
		imageAssetsLoading,
		imageAssetView,
		imageAssetQuery,
		imageAssetSizeBand,
		imageAssetSourceFilter,
		imageAssetStorageQuota,
		deletingImageAssetId,
		canDeleteImageAssets,
		imageAssetBrowserExpanded,
		hiddenImageAssetCount,
		compactLimit,
		assetFilterInputId,
		hasImage,
		canFilterImageAssets,
		canSelectImageAsset,
		canUseSelectedImageAsset,
		canReplaceSelectedLayerFromAsset,
		selectedImageLayer,
		selectedImageLayerIsAiResult,
		selectedImageReplacementMode,
		imageLayerDisplayName,
		formatAssetDisplayName,
		formatAssetShortId,
		formatAssetOptionLabel,
		formatAssetCompactBytes,
		formatAssetBytes,
		formatAssetDate,
		formatImageAssetUsageLabel,
		formatImageAssetReadyStatus,
		formatImageAssetFileType,
		getImageAssetUsageCount,
		shouldShowImageAssetThumbnail,
		shouldShowImageAssetPreview,
		imageAssetPreviewUrl,
		clearImageAssetThumbnailFailure,
		markImageAssetThumbnailFailed,
		clearImageAssetPreviewFailure,
		markImageAssetPreviewFailed,
		onToggleDrawer,
		onImageAssetQueryChange,
		onSetImageAssetSizeBand,
		onSetImageAssetSourceFilter,
		onDeleteImageAsset,
		onSetImageAssetView,
		onImageAssetSelectionChange,
		onSelectImageAsset,
		onAddSelectedImageAssetLayer,
		onReplaceSelectedImageLayerFromAsset,
		onToggleImageAssetBrowserExpanded,
	}: Props = $props();

	// Build signedAssetSrc params so a browser <img> can load a backend asset via
	// a signed assetToken (no Bearer header on <img> → 401 without it). blob:
	// local previews pass through the action unchanged.
	function assetThumbnailParams(asset: ProjectImageAssetSummary): SignedAssetSrcParams {
		const size = imageAssetView === "grid" ? { w: 160, h: 120 } : { w: 72, h: 72 };
		return {
			projectId: projectId ?? "",
			imageId: asset.imageId,
			url: thumbnailUrl(projectId ?? "", asset.imageId, size.w, size.h),
			purpose: "thumbnail",
			// Mark failed only AFTER signedAssetSrc exhausts its token re-mint retry,
			// not on a raw <img onerror> (which aborts the re-sign on the first error).
			onFailed: () => markImageAssetThumbnailFailed(asset),
		};
	}

	function assetPreviewParams(asset: ProjectImageAssetSummary): SignedAssetSrcParams {
		return {
			projectId: projectId ?? "",
			imageId: asset.imageId,
			url: imageAssetPreviewUrl(asset),
			purpose: "editor_preview",
			// Mark failed only AFTER signedAssetSrc exhausts its token re-mint retry,
			// not on a raw <img onerror> (which aborts the re-sign on the first error).
			onFailed: () => markImageAssetPreviewFailed(asset),
		};
	}

	// Inline delete confirmation (no modal — the inspector is cramped). Clicking the
	// trash icon arms a confirm row on that asset; a second click commits. The
	// orchestrator owns the real delete + toast and surfaces an in-use warning by
	// passing `force` through. When a non-forced delete comes back as
	// `referencedByPages` (the asset is still on a live page) we re-arm THAT row in
	// "force" mode so the user can confirm a forced delete inline.
	let pendingDeleteAssetId = $state<string>("");
	let forceDeleteAssetId = $state<string>("");

	function armDelete(asset: ProjectImageAssetSummary, event: MouseEvent): void {
		event.stopPropagation();
		if (pendingDeleteAssetId === asset.assetId) {
			pendingDeleteAssetId = "";
			forceDeleteAssetId = "";
		} else {
			pendingDeleteAssetId = asset.assetId;
			forceDeleteAssetId = "";
		}
	}

	function cancelDelete(event: MouseEvent): void {
		event.stopPropagation();
		pendingDeleteAssetId = "";
		forceDeleteAssetId = "";
	}

	async function commitDelete(asset: ProjectImageAssetSummary, force: boolean, event: MouseEvent): Promise<void> {
		event.stopPropagation();
		pendingDeleteAssetId = "";
		forceDeleteAssetId = "";
		const outcome = await onDeleteImageAsset(asset, force);
		// If the backend refused because the asset is still on a live page, re-arm
		// this row in force mode so the user can explicitly confirm an in-use delete.
		if (outcome && typeof outcome === "object" && "referencedByPages" in outcome) {
			pendingDeleteAssetId = asset.assetId;
			forceDeleteAssetId = asset.assetId;
		}
	}

	// Space-used total for the open project, from the SAME storage-quota source the
	// usage dashboard reads. `enforced` projects show used / limit; unmetered ones
	// show just the used figure.
	let spaceUsedLabel = $derived.by(() => {
		const q = imageAssetStorageQuota;
		if (!q) return "";
		const used = formatAssetBytes(q.usedBytes);
		if (q.enforced && q.limitBytes > 0) {
			return `${used} / ${formatAssetBytes(q.limitBytes)}`;
		}
		return used;
	});
	let spacePercentLabel = $derived.by(() => {
		const q = imageAssetStorageQuota;
		if (!q || !q.enforced || q.limitBytes <= 0) return "";
		return `${Math.min(100, Math.round(q.percentUsed))}%`;
	});
</script>

<details class="asset-library-drawer" open={drawerOpen}>
	<summary class="asset-library-summary" onclick={onToggleDrawer}>
		<span>{$_("assetLibrary.drawerTitle")}</span>
		<small>{filteredImageAssets.length}/{imageAssets.length} {$_("assetLibrary.readySuffix")}</small>
	</summary>
	<div class="asset-library-body">
		{#if selectedImageReplacementMode && selectedImageLayer}
			<div class="asset-replacement-mode-card" aria-label={$_("assetLibrary.replacementModeAria")}>
				<span>{$_("assetLibrary.replacingImageOf", { values: { name: imageLayerDisplayName(selectedImageLayer) } })}</span>
				<small>{$_("assetLibrary.replacementModeHint")}</small>
			</div>
		{/if}
		<div class="asset-library-filter-row">
			<input
				id={assetFilterInputId}
				class="panel-input asset-filter-input"
				type="search"
				placeholder={$_("assetLibrary.searchPlaceholder")}
				value={imageAssetQuery}
				oninput={onImageAssetQueryChange}
				readonly={!canFilterImageAssets}
				aria-readonly={!canFilterImageAssets}
			/>
			<div class="asset-view-toggle" aria-label={$_("assetLibrary.viewToggleAria")}>
				<button
					type="button"
					class:active={imageAssetView === "list"}
					aria-pressed={imageAssetView === "list"}
					aria-label={$_("assetLibrary.viewListAria")}
					title={$_("assetLibrary.viewListTitle")}
					onclick={() => onSetImageAssetView("list")}
				>{$_("assetLibrary.viewList")}</button>
				<button
					type="button"
					class:active={imageAssetView === "grid"}
					aria-pressed={imageAssetView === "grid"}
					aria-label={$_("assetLibrary.viewGridAria")}
					title={$_("assetLibrary.viewGridTitle")}
					onclick={() => onSetImageAssetView("grid")}
				>{$_("assetLibrary.viewGrid")}</button>
			</div>
			<span class="asset-filter-count">
				{filteredImageAssets.length}/{imageAssets.length}
			</span>
		</div>
		<div class="asset-library-filter-row asset-library-filter-row-secondary">
			<label class="asset-mini-select">
				<span>{$_("assetLibrary.filterSizeLabel")}</span>
				<select
					class="panel-select"
					value={imageAssetSizeBand}
					onchange={(event) => onSetImageAssetSizeBand((event.currentTarget as HTMLSelectElement).value as AssetSizeBand)}
					disabled={!canFilterImageAssets}
					aria-label={$_("assetLibrary.filterSizeLabel")}
				>
					<option value="all">{$_("assetLibrary.sizeAll")}</option>
					<option value="lt500k">{$_("assetLibrary.sizeLt500k")}</option>
					<option value="500kto2m">{$_("assetLibrary.size500kTo2m")}</option>
					<option value="gt2m">{$_("assetLibrary.sizeGt2m")}</option>
				</select>
			</label>
			<label class="asset-mini-select">
				<span>{$_("assetLibrary.filterSourceLabel")}</span>
				<select
					class="panel-select"
					value={imageAssetSourceFilter}
					onchange={(event) => onSetImageAssetSourceFilter((event.currentTarget as HTMLSelectElement).value as AssetSourceFilter)}
					disabled={!canFilterImageAssets}
					aria-label={$_("assetLibrary.filterSourceLabel")}
				>
					<option value="all">{$_("assetLibrary.sourceAll")}</option>
					<option value="uploaded">{$_("assetLibrary.sourceUploaded")}</option>
					<option value="ai">{$_("assetLibrary.sourceAi")}</option>
				</select>
			</label>
		</div>
		{#if spaceUsedLabel}
			<div class="asset-space-used" aria-label={$_("assetLibrary.spaceUsedLabel")}>
				<span class="asset-space-used-label">{$_("assetLibrary.spaceUsedLabel")}</span>
				<strong class="asset-space-used-value">{spaceUsedLabel}</strong>
				{#if spacePercentLabel}<small class="asset-space-used-pct">{spacePercentLabel}</small>{/if}
			</div>
		{/if}
		{#if !selectedImageReplacementMode}
			<div class="asset-reuse-row">
				<label class="panel-label asset-reuse-select-label" for="image-asset-library">
					{$_("assetLibrary.reuseLabel")}
				</label>
				{#if canSelectImageAsset}
					<select
						id="image-asset-library"
						class="panel-select asset-reuse-select"
						value={selectedImageAssetId}
						onchange={onImageAssetSelectionChange}
					>
						<option value="">{$_("assetLibrary.selectImage")}</option>
						{#each filteredImageAssets as asset (asset.assetId)}
							<option value={asset.assetId}>
								{formatAssetOptionLabel(asset)}
							</option>
						{/each}
					</select>
				{:else}
					<span class="asset-action-receipt asset-reuse-select">
						{imageAssetsLoading ? $_("assetLibrary.loadingImages") : filteredImageAssets.length === 0 ? $_("assetLibrary.noImagesFound") : hasImage ? $_("assetLibrary.openChapterFirst") : $_("assetLibrary.openPageImageFirst")}
					</span>
				{/if}
				{#if selectedImageAssetVisible || !selectedImageLayer}
					{#if canUseSelectedImageAsset}
						<button
							class="panel-btn asset-reuse-btn"
							onclick={onAddSelectedImageAssetLayer}
							aria-label={$_("assetLibrary.reuseThisImageAria")}
							title={$_("assetLibrary.addAsNewLayerTitle")}
						>
							{$_("assetLibrary.addNew")}
						</button>
					{:else}
						<span class="asset-action-receipt asset-reuse-btn">{$_("assetLibrary.selectImageFirst")}</span>
					{/if}
					{#if selectedImageLayer && selectedImageLayer.locked !== true}
						<button
							class="panel-btn asset-reuse-btn secondary"
							onclick={onReplaceSelectedImageLayerFromAsset}
							aria-label={$_("assetLibrary.replaceInSelectedLayerAria")}
							title={$_("assetLibrary.replaceInSelectedLayerTitle")}
						>
							{$_("assetLibrary.replace")}
						</button>
					{/if}
				{:else}
					<span class="asset-reuse-note">{$_("assetLibrary.selectBeforeAddOrReplace")}</span>
				{/if}
			</div>
		{/if}
	</div>
</details>
{#if betweenDrawerAndList}{@render betweenDrawerAndList()}{/if}
{#if drawerOpen && filteredImageAssets.length > 0}
	<div
		class="asset-browser-list"
		class:asset-browser-grid={imageAssetView === "grid"}
		aria-label={$_("assetLibrary.reusableListAria")}
	>
		{#each visibleImageAssets as asset (asset.assetId)}
			<div class="asset-browser-item" class:deleting={deletingImageAssetId === asset.imageId}>
				<button
					class="asset-browser-row"
					class:active={selectedImageAssetId === asset.assetId}
					onclick={() => onSelectImageAsset(asset.assetId)}
					aria-label={$_("assetLibrary.selectReusableAria", { values: { name: formatAssetDisplayName(asset), id: formatAssetShortId(asset) } })}
					title={formatAssetOptionLabel(asset)}
				>
					<span class="asset-browser-thumb" aria-hidden="true">
						{#if shouldShowImageAssetThumbnail(asset)}
							<img
								use:signedAssetSrc={assetThumbnailParams(asset)}
								alt=""
								loading="lazy"
								decoding="async"
								onload={() => clearImageAssetThumbnailFailure(asset)}
							/>
						{:else}
							<span>{formatAssetShortId(asset).slice(0, 2).toUpperCase()}</span>
						{/if}
					</span>
					<span class="asset-browser-main">
						<span class="asset-browser-name">{formatAssetDisplayName(asset)}</span>
						<span class="asset-browser-meta">
							{asset.width}x{asset.height}
							/ {formatAssetCompactBytes(asset.sizeBytes)}
							/ {formatImageAssetUsageLabel(asset)}
						</span>
					</span>
					<span class="asset-browser-id">{formatAssetShortId(asset)}</span>
				</button>
				{#if canDeleteImageAssets}
					{#if pendingDeleteAssetId === asset.assetId}
						<span class="asset-row-delete-confirm" role="group" aria-label={$_("assetLibrary.deleteConfirmAria")}>
							{#if forceDeleteAssetId === asset.assetId || getImageAssetUsageCount(asset) > 0}
								<button
									type="button"
									class="asset-row-delete-go danger"
									onclick={(event) => commitDelete(asset, true, event)}
									disabled={deletingImageAssetId === asset.imageId}
									title={$_("assetLibrary.deleteForceTitle")}
								>{$_("assetLibrary.deleteForce")}</button>
							{:else}
								<button
									type="button"
									class="asset-row-delete-go danger"
									onclick={(event) => commitDelete(asset, false, event)}
									disabled={deletingImageAssetId === asset.imageId}
									title={$_("assetLibrary.deleteConfirmTitle")}
								>{$_("assetLibrary.deleteConfirm")}</button>
							{/if}
							<button
								type="button"
								class="asset-row-delete-cancel"
								onclick={cancelDelete}
								disabled={deletingImageAssetId === asset.imageId}
							>{$_("assetLibrary.deleteCancel")}</button>
						</span>
					{:else}
						<button
							type="button"
							class="asset-row-delete"
							onclick={(event) => armDelete(asset, event)}
							disabled={deletingImageAssetId === asset.imageId}
							aria-label={`${$_("assetLibrary.deleteAsset")} ${formatAssetDisplayName(asset)}`}
							title={$_("assetLibrary.deleteAsset")}
						>
							{#if deletingImageAssetId === asset.imageId}…{:else}✕{/if}
						</button>
					{/if}
				{/if}
			</div>
		{/each}
	</div>
	{#if hiddenImageAssetCount > 0 || (imageAssetBrowserExpanded && !imageAssetQuery.trim() && filteredImageAssets.length > compactLimit)}
		<button
			type="button"
			class="asset-browser-more-row"
			onclick={onToggleImageAssetBrowserExpanded}
			aria-label={imageAssetBrowserExpanded ? $_("assetLibrary.collapseLibraryAria") : $_("assetLibrary.showAllReusableAria", { values: { n: filteredImageAssets.length } })}
		>
			{#if imageAssetBrowserExpanded}
				{$_("assetLibrary.collapseList")}
			{:else}
				{$_("assetLibrary.showAllCount", { values: { n: filteredImageAssets.length } })}
				<span>{$_("assetLibrary.hiddenCount", { values: { n: hiddenImageAssetCount } })}</span>
			{/if}
		</button>
	{/if}
{:else if drawerOpen}
	<div class="asset-browser-empty asset-action-receipt" role="status">
		{imageAssetsLoading ? $_("assetLibrary.loadingImages") : imageAssets.length === 0 ? $_("assetLibrary.noReusableYet") : $_("assetLibrary.noImagesFound")}
	</div>
{/if}
{#if drawerOpen && selectedImageAsset}
	<div class="asset-detail-card" aria-label={$_("assetLibrary.detailCardAria")}>
		<div class="asset-detail-title">
			<span>{formatAssetDisplayName(selectedImageAsset)}</span>
			<small>{formatAssetShortId(selectedImageAsset)}</small>
		</div>
		<div class="asset-detail-preview">
			<span class="asset-detail-preview-image" aria-hidden="true">
				{#if shouldShowImageAssetPreview(selectedImageAsset)}
					<img
						use:signedAssetSrc={assetPreviewParams(selectedImageAsset)}
						alt=""
						loading="lazy"
						decoding="async"
						onload={() => clearImageAssetPreviewFailure(selectedImageAsset)}
					/>
				{:else}
					<span>{formatAssetShortId(selectedImageAsset).slice(0, 2).toUpperCase()}</span>
				{/if}
			</span>
			<span class="asset-detail-preview-copy">
				<span>{$_("assetLibrary.imageToUse")}</span>
				<small>{selectedImageAsset.width} x {selectedImageAsset.height} / {formatAssetBytes(selectedImageAsset.sizeBytes)}</small>
			</span>
		</div>
		<div class="asset-detail-grid">
			<span>{$_("assetLibrary.detailImage")}</span>
			<strong>{selectedImageAsset.width} x {selectedImageAsset.height}</strong>
			<span>{$_("assetLibrary.detailFile")}</span>
			<strong>{formatAssetBytes(selectedImageAsset.sizeBytes)}</strong>
			<span>{$_("assetLibrary.detailUsage")}</span>
			<strong>{$_("assetLibrary.usageLayers", { values: { n: getImageAssetUsageCount(selectedImageAsset) } })}</strong>
			<span>{$_("assetLibrary.detailStatus")}</span>
			<strong>{formatImageAssetReadyStatus(selectedImageAsset)}</strong>
			<span>{$_("assetLibrary.detailUpdated")}</span>
			<strong>{formatAssetDate(selectedImageAsset.updatedAt)}</strong>
			<span>{$_("assetLibrary.detailFileType")}</span>
			<strong>{formatImageAssetFileType(selectedImageAsset)}</strong>
		</div>
		{#if selectedImageLayer && !selectedImageLayerIsAiResult}
			<div class="asset-detail-actions" aria-label={$_("assetLibrary.applyToLayerAria")}>
				<div class="asset-detail-action-copy">
					<span>{$_("assetLibrary.selectedLayerPrefix", { values: { name: imageLayerDisplayName(selectedImageLayer) } })}</span>
					<small>{$_("assetLibrary.replaceKeepsHint")}</small>
				</div>
				<div class="asset-detail-action-buttons">
					{#if canReplaceSelectedLayerFromAsset}
						<button
							type="button"
							class="panel-btn panel-btn-primary"
							onclick={onReplaceSelectedImageLayerFromAsset}
							aria-label={$_("assetLibrary.replaceSelectedWithAria", { values: { name: formatAssetDisplayName(selectedImageAsset) } })}
							title={$_("assetLibrary.replaceNoMoveTitle")}
						>
							{$_("assetLibrary.replaceThisLayer")}
						</button>
					{:else}
						<span class="asset-action-receipt asset-detail-action-receipt">
							{selectedImageLayer.locked === true ? $_("assetLibrary.unlockBeforeReplace") : $_("assetLibrary.selectUsableImageFirst")}
						</span>
					{/if}
					{#if canUseSelectedImageAsset}
						<button
							type="button"
							class="panel-btn"
							onclick={onAddSelectedImageAssetLayer}
							aria-label={$_("assetLibrary.addAsNewLayerAria", { values: { name: formatAssetDisplayName(selectedImageAsset) } })}
							title={$_("assetLibrary.addSeparateLayerTitle")}
						>
							{$_("assetLibrary.addAsNewLayer")}
						</button>
					{:else}
						<span class="asset-action-receipt asset-detail-action-receipt">{$_("assetLibrary.selectUsableImageFirst")}</span>
					{/if}
				</div>
			</div>
		{/if}
	</div>
{:else if drawerOpen && selectedImageAssetId && !selectedImageAssetVisible}
	<div class="asset-detail-card muted" aria-label={$_("assetLibrary.selectedHiddenAria")}>
		{$_("assetLibrary.selectedHiddenByFilter")}
	</div>
{/if}

<style>
	/*
	 * `.asset-library-*`, `.asset-browser-*`, `.asset-detail-*`,
	 * `.asset-replacement-mode-card`, `.asset-action-receipt`,
	 * `.asset-reuse-*`, `.asset-filter-*`, and `.asset-view-toggle`
	 * styles live in LayersInspectorPanel.svelte. They are wrapped with
	 * `:global()` there so this child can reuse them without
	 * duplicating the visual rules.
	 *
	 * `.panel-btn`, `.panel-btn-primary`, `.panel-input`, `.panel-select`,
	 * `.panel-label` are already global classes used across the app.
	 *
	 * The asset-LIBRARY additions below (size/source filters, space-used,
	 * per-row delete) are NEW to this component, so their styles are scoped
	 * here rather than reaching back into the parent.
	 */
	.asset-library-filter-row-secondary {
		gap: 8px;
		margin-top: 6px;
	}
	.asset-mini-select {
		display: flex;
		flex-direction: column;
		gap: 3px;
		flex: 1 1 0;
		min-width: 0;
		font-size: 11px;
		color: var(--color-ws-text, #9a9aa8);
	}
	.asset-mini-select :global(select) {
		width: 100%;
		min-width: 0;
	}
	.asset-space-used {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin-top: 8px;
		padding: 6px 10px;
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.08));
	}
	.asset-space-used-label {
		font-size: 11px;
		color: var(--color-ws-text, #9a9aa8);
	}
	.asset-space-used-value {
		font-size: 13px;
		font-weight: 700;
		color: var(--color-ws-ink, #ececf2);
	}
	.asset-space-used-pct {
		margin-left: auto;
		font-size: 11px;
		color: var(--color-ws-faint, #6b6b78);
	}
	.asset-browser-item {
		display: flex;
		align-items: stretch;
		gap: 4px;
	}
	.asset-browser-item > :global(.asset-browser-row) {
		flex: 1 1 auto;
		min-width: 0;
	}
	.asset-browser-item.deleting {
		opacity: 0.55;
	}
	.asset-row-delete,
	.asset-row-delete-go,
	.asset-row-delete-cancel {
		flex: none;
		border: 1px solid var(--ws-hair-strong, rgba(255, 255, 255, 0.12));
		background: rgba(255, 255, 255, 0.03);
		color: var(--color-ws-text, #9a9aa8);
		border-radius: 8px;
		font-family: inherit;
		font-size: 12px;
		cursor: pointer;
		padding: 0 8px;
	}
	.asset-row-delete {
		width: 30px;
	}
	.asset-row-delete:hover:not(:disabled),
	.asset-row-delete-go:hover:not(:disabled) {
		border-color: rgba(251, 113, 133, 0.5);
		color: #ffd0d8;
		background: rgba(251, 113, 133, 0.1);
	}
	.asset-row-delete-confirm {
		display: flex;
		gap: 4px;
		align-items: stretch;
	}
	.asset-row-delete-go.danger {
		color: #ffd0d8;
		border-color: rgba(251, 113, 133, 0.4);
		background: rgba(251, 113, 133, 0.12);
		font-weight: 700;
	}
	.asset-row-delete:disabled,
	.asset-row-delete-go:disabled,
	.asset-row-delete-cancel:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
