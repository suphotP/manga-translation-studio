<script lang="ts">
	import type {
		ProjectVersion,
		VersionComparison,
		VersionLayerChangeType,
		VersionPageDiff,
		VersionRestoreScope,
	} from "$lib/api/client.js";
	import { signedAssetSrc, type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";
	import { _ } from "$lib/i18n";

	interface Props {
		projectOpen: boolean;
		projectId: string | null;
		versions: ProjectVersion[];
		comparison: VersionComparison | null;
		comparisonLoading: boolean;
		formatSource: (value: ProjectVersion["source"]) => string;
		formatDate: (value: string) => string;
		imageUrl: (imageId: string) => string;
		onCompare: (targetVersionId: string, baseVersionId?: string) => void | Promise<void>;
		onClear: () => void;
		onRestoreScope: (versionId: string, scope: VersionRestoreScope) => void | Promise<void>;
	}

	let {
		projectOpen,
		projectId,
		versions,
		comparison,
		comparisonLoading,
		formatSource,
		formatDate,
		imageUrl,
		onCompare,
		onClear,
		onRestoreScope,
	}: Props = $props();

	// Signed-token params for a diff <img>: the full-image URL plus asset identity
	// so signedAssetSrc can attach a signed assetToken (browser <img> has no Bearer
	// header → 401). Returns null when no project/image.
	function diffImageParams(imageId: string): SignedAssetSrcParams | null {
		if (!projectId || !imageId) return null;
		return { projectId, imageId, url: imageUrl(imageId), purpose: "editor_preview" };
	}

	// "" → live current project state as the base side.
	let baseVersionId = $state("");
	let targetVersionId = $state("");
	let viewMode = $state<"side-by-side" | "overlay">("side-by-side");
	let overlaySlider = $state(50);
	let selectedPageIndex = $state<number | null>(null);

	let canCompare = $derived(projectOpen && Boolean(projectId) && targetVersionId.length > 0 && !comparisonLoading);

	function versionLabel(version: ProjectVersion): string {
		return version.label?.trim() || formatSource(version.source);
	}

	function versionOptionLabel(version: ProjectVersion): string {
		return `${versionLabel(version)} · ${formatDate(version.createdAt)}`;
	}

	async function runCompare(): Promise<void> {
		if (!canCompare) return;
		selectedPageIndex = null;
		await onCompare(targetVersionId, baseVersionId || undefined);
	}

	function clearCompare(): void {
		selectedPageIndex = null;
		onClear();
	}

	// $_() is re-read on each call, so these stay reactive across locale switches
	// (no frozen component-scope const).
	function changeLabel(change: VersionLayerChangeType): string {
		const keys: Record<VersionLayerChangeType, string> = {
			added: "versionDiff.changeAdded",
			removed: "versionDiff.changeRemoved",
			moved: "versionDiff.changeMoved",
			edited: "versionDiff.changeEdited",
			restyled: "versionDiff.changeRestyled",
		};
		return $_(keys[change]);
	}

	function pageStatusLabel(status: VersionPageDiff["status"]): string {
		switch (status) {
			case "added": return $_("versionDiff.pageStatusAdded");
			case "removed": return $_("versionDiff.pageStatusRemoved");
			case "changed": return $_("versionDiff.pageStatusChanged");
			default: return $_("versionDiff.pageStatusUnchanged");
		}
	}

	let selectedPage = $derived(
		selectedPageIndex === null
			? null
			: comparison?.diff.pages.find((p) => p.pageIndex === selectedPageIndex) ?? null
	);

	// Prefer the page diff's composited image ids (which honour `page.edits.imageId`
	// for clean/export cases) and fall back to the original summary image only when
	// the diff entry has no image id (e.g. added/removed pages render one empty side).
	function summaryPageImageId(
		side: "base" | "target",
		pageIndex: number,
	): string | undefined {
		const pages = side === "base" ? comparison?.diff.base.pages : comparison?.diff.target.pages;
		return pages?.find((p) => p.pageIndex === pageIndex)?.imageId;
	}

	function basePageImageId(page: VersionPageDiff): string | undefined {
		return page.baseImageId ?? summaryPageImageId("base", page.pageIndex);
	}

	function targetPageImageId(page: VersionPageDiff): string | undefined {
		return page.targetImageId ?? summaryPageImageId("target", page.pageIndex);
	}

	function targetVersionForRestore(): string | null {
		return comparison?.targetVersion.versionId ?? null;
	}

	function restorePage(pageIndex: number): void {
		const versionId = targetVersionForRestore();
		if (!versionId) return;
		void onRestoreScope(versionId, { pageIndex });
	}

	function restoreLayer(pageIndex: number, layerId: string): void {
		const versionId = targetVersionForRestore();
		if (!versionId) return;
		void onRestoreScope(versionId, { pageIndex, layerId });
	}

	function formatDelta(value: number): string {
		return value > 0 ? `+${value}` : `${value}`;
	}
</script>

<div class="diff-panel">
	{#if !projectOpen}
		<div class="empty-state">{$_("versionDiff.openProjectFirst")}</div>
	{:else if !versions.length}
		<div class="empty-state">{$_("versionDiff.noVersionsYet")}</div>
	{:else}
		<div class="diff-pickers" aria-label={$_("versionDiff.pickersLabel")}>
			<label>
				<span>{$_("versionDiff.baseLabel")}</span>
				<select bind:value={baseVersionId} aria-label={$_("versionDiff.baseSelectLabel")}>
					<option value="">{$_("versionDiff.currentState")}</option>
					{#each versions as version (version.versionId)}
						<option value={version.versionId}>{versionOptionLabel(version)}</option>
					{/each}
				</select>
			</label>
			<label>
				<span>{$_("versionDiff.targetLabel")}</span>
				<select bind:value={targetVersionId} aria-label={$_("versionDiff.targetSelectLabel")}>
					<option value="" disabled>{$_("versionDiff.selectVersion")}</option>
					{#each versions as version (version.versionId)}
						<option value={version.versionId}>{versionOptionLabel(version)}</option>
					{/each}
				</select>
			</label>
			<div class="diff-picker-actions">
				<button class="diff-btn diff-btn-primary ws-grad-primary" disabled={!canCompare} onclick={runCompare}>
					{comparisonLoading ? $_("versionDiff.comparing") : $_("versionDiff.compare")}
				</button>
				{#if comparison}
					<button class="diff-btn ws-btn-ghost" onclick={clearCompare}>{$_("versionDiff.clear")}</button>
				{/if}
			</div>
		</div>

		{#if comparisonLoading}
			<div class="empty-state">{$_("versionDiff.computingDiff")}</div>
		{:else if comparison}
			<section class="diff-summary ws-panel" aria-label={$_("versionDiff.summaryLabel")}>
				<div class="diff-summary-head">
					<span class="diff-chip diff-chip-base">
						{comparison.baseVersion ? versionLabel(comparison.baseVersion) : $_("versionDiff.currentState")}
					</span>
					<span class="diff-arrow">→</span>
					<span class="diff-chip diff-chip-target">{versionLabel(comparison.targetVersion)}</span>
				</div>
				<div class="diff-stats">
					<span>{$_("versionDiff.statPages", { values: { delta: formatDelta(comparison.diff.pageDelta) } })}</span>
					<span>{$_("versionDiff.statTextLayers", { values: { delta: formatDelta(comparison.diff.textLayerDelta) } })}</span>
					<span>{$_("versionDiff.statImageLayers", { values: { delta: formatDelta(comparison.diff.imageLayerDelta) } })}</span>
					{#if comparison.diff.editLayerDelta !== undefined && comparison.diff.editLayerDelta !== 0}
						<span>{$_("versionDiff.statEditLayers", { values: { delta: formatDelta(comparison.diff.editLayerDelta) } })}</span>
					{/if}
				</div>
				<div class="diff-counts">
					{$_("versionDiff.counts", { values: {
						added: comparison.diff.addedPageCount,
						removed: comparison.diff.removedPageCount,
						changed: comparison.diff.changedPageCount,
					} })}
				</div>
			</section>

			{#if !comparison.diff.pages.length}
				<div class="empty-state">{$_("versionDiff.noDiff")}</div>
			{:else}
				<ul class="diff-page-list" aria-label={$_("versionDiff.changedPagesLabel")}>
					{#each comparison.diff.pages as page (page.pageIndex)}
						<li class="diff-page-item">
							<button
								type="button"
								class="diff-page-row ws-panel-quiet"
								class:selected={selectedPageIndex === page.pageIndex}
								class:added={page.status === "added"}
								class:removed={page.status === "removed"}
								onclick={() => (selectedPageIndex = selectedPageIndex === page.pageIndex ? null : page.pageIndex)}
							>
								<span class="diff-page-name">{page.label}</span>
								<span class="diff-page-status">{pageStatusLabel(page.status)}</span>
								<span class="diff-page-meta">
									{$_("versionDiff.metaTextCount", { values: { base: page.baseTextLayerCount, target: page.targetTextLayerCount } })}
									{#if page.imageChanged}{$_("versionDiff.metaImageChanged")}{/if}
									{#if (page.baseEditLayerCount ?? 0) !== (page.targetEditLayerCount ?? 0)}{$_("versionDiff.metaEditCount", { values: { base: page.baseEditLayerCount ?? 0, target: page.targetEditLayerCount ?? 0 } })}{/if}
									{#if page.layers.length}{$_("versionDiff.metaLayerCount", { values: { count: page.layers.length } })}{/if}
								</span>
							</button>
						</li>
					{/each}
				</ul>

				{#if selectedPage}
					<section class="diff-detail ws-panel" aria-label={$_("versionDiff.detailLabel")}>
						<div class="diff-detail-head">
							<strong>{selectedPage.label}</strong>
							<div class="diff-mode-toggle" role="group" aria-label={$_("versionDiff.viewModeLabel")}>
								<button
									class="diff-mode-btn ws-seg"
									class:active={viewMode === "side-by-side"}
									onclick={() => (viewMode = "side-by-side")}
								>{$_("versionDiff.viewSideBySide")}</button>
								<button
									class="diff-mode-btn ws-seg"
									class:active={viewMode === "overlay"}
									onclick={() => (viewMode = "overlay")}
								>{$_("versionDiff.viewOverlay")}</button>
							</div>
						</div>

						{#if projectId}
							{@const baseImg = basePageImageId(selectedPage)}
							{@const targetImg = targetPageImageId(selectedPage)}
							{#if viewMode === "side-by-side"}
								<div class="diff-visual diff-visual-split">
									<figure>
										<figcaption>{$_("versionDiff.base")}</figcaption>
										{#if baseImg}
											<img use:signedAssetSrc={diffImageParams(baseImg)} alt={$_("versionDiff.basePageAlt")} loading="lazy" />
										{:else}
											<div class="diff-no-image">{$_("versionDiff.noImage")}</div>
										{/if}
									</figure>
									<figure>
										<figcaption>{$_("versionDiff.target")}</figcaption>
										{#if targetImg}
											<img use:signedAssetSrc={diffImageParams(targetImg)} alt={$_("versionDiff.targetPageAlt")} loading="lazy" />
										{:else}
											<div class="diff-no-image">{$_("versionDiff.noImage")}</div>
										{/if}
									</figure>
								</div>
							{:else}
								<div class="diff-visual diff-visual-overlay">
									{#if baseImg}
										<img class="diff-overlay-base" use:signedAssetSrc={diffImageParams(baseImg)} alt={$_("versionDiff.basePageAlt")} loading="lazy" />
									{/if}
									{#if targetImg}
										<img
											class="diff-overlay-target"
											use:signedAssetSrc={diffImageParams(targetImg)}
											alt={$_("versionDiff.targetPageAlt")}
											loading="lazy"
											style={`clip-path: inset(0 0 0 ${overlaySlider}%);`}
										/>
									{/if}
									<input
										class="diff-overlay-slider"
										type="range"
										min="0"
										max="100"
										bind:value={overlaySlider}
										aria-label={$_("versionDiff.overlaySliderLabel")}
									/>
								</div>
							{/if}
						{/if}

						<div class="diff-detail-actions">
							<button class="diff-btn diff-btn-restore ws-btn-ghost" onclick={() => restorePage(selectedPage!.pageIndex)}>
								{$_("versionDiff.restorePage")}
							</button>
						</div>

						{#if selectedPage.layers.length}
							<ul class="diff-layer-list" aria-label={$_("versionDiff.changedLayersLabel")}>
								{#each selectedPage.layers as layer (layer.layerId)}
									<li class="diff-layer-row ws-panel-quiet">
										<div class="diff-layer-head">
											<span class="diff-layer-kind">{layer.kind === "text" ? $_("versionDiff.layerKindText") : $_("versionDiff.layerKindImage")}</span>
											<span class="diff-layer-name">{layer.name ?? layer.layerId}</span>
											<span class="diff-layer-changes">
												{#each layer.changes as change (change)}
													<em class={`diff-change diff-change-${change}`}>{changeLabel(change)}</em>
												{/each}
											</span>
										</div>
										{#if layer.textBefore !== undefined || layer.textAfter !== undefined}
											<div class="diff-text-change">
												<del>{layer.textBefore ?? ""}</del>
												<ins>{layer.textAfter ?? ""}</ins>
											</div>
										{/if}
										{#if layer.changes[0] !== "added"}
											<button
												class="diff-btn diff-btn-restore-layer ws-btn-ghost"
												onclick={() => restoreLayer(selectedPage!.pageIndex, layer.layerId)}
											>
												{$_("versionDiff.restoreLayer")}
											</button>
										{/if}
									</li>
								{/each}
							</ul>
						{:else}
							<div class="empty-state">{$_("versionDiff.onlyBackgroundChanged")}</div>
						{/if}
					</section>
				{/if}
			{/if}
		{/if}
	{/if}
</div>

<style>
	.diff-panel {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.empty-state {
		color: var(--color-ws-text, #9A9AA8);
		font-size: 11px;
	}

	.diff-pickers {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 8px;
		align-items: end;
	}

	.diff-pickers label {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 4px;
		color: var(--color-ws-text, #9A9AA8);
		font-size: 10px;
		font-weight: 760;
	}

	.diff-pickers select {
		min-width: 0;
		min-height: 36px;
		padding: 0 8px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 70%, transparent);
		color: var(--color-ws-ink, #ECECF2);
		font-size: 12px;
	}

	.diff-picker-actions {
		display: flex;
		grid-column: 1 / -1;
		gap: 6px;
	}

	.diff-btn {
		min-height: 36px;
		padding: 0 12px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: color-mix(in srgb, var(--color-ws-surface, #15151D) 42%, transparent);
		color: var(--color-ws-text, #9A9AA8);
		font-size: 12px;
		font-weight: 760;
		cursor: pointer;
	}

	.diff-btn:hover {
		color: var(--color-ws-ink, #ECECF2);
		border-color: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 44%, transparent);
	}

	.diff-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.diff-btn-primary {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 52%, transparent);
		background: linear-gradient(100deg, var(--color-ws-violet, #8B5CF6) 0%, var(--color-ws-accent, #7C5CFF) 100%);
		color: var(--color-ws-ink, #ECECF2);
	}

	.diff-btn-restore,
	.diff-btn-restore-layer {
		border-color: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 46%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 12%, transparent);
		color: var(--color-ws-amber, #FBBF24);
	}

	.diff-btn-restore-layer {
		min-height: 36px;
		align-self: flex-start;
		font-size: 11px;
	}

	.diff-summary {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 9px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 22%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		background: linear-gradient(
			135deg,
			color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 10%, transparent),
			color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 78%, transparent)
		);
	}

	.diff-summary-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.diff-chip {
		overflow: hidden;
		max-width: 45%;
		padding: 3px 8px;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 800;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.diff-chip-base {
		border: 1px solid var(--ws-hair-strong);
		background: color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 64%, transparent);
		color: var(--color-ws-ink, #ECECF2);
	}

	.diff-chip-target {
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 40%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 18%, transparent);
		color: color-mix(in srgb, var(--color-ws-violet, #8B5CF6) 66%, var(--color-ws-ink, #ECECF2));
	}

	.diff-arrow {
		color: var(--color-ws-text, #9A9AA8);
		font-size: 13px;
	}

	.diff-stats {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		color: var(--color-ws-ink, #ECECF2);
		font-size: 11px;
		font-weight: 700;
	}

	.diff-counts {
		color: var(--color-ws-text, #9A9AA8);
		font-size: 10px;
	}

	.diff-page-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.diff-page-item {
		display: block;
	}

	.diff-page-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 2px 8px;
		width: 100%;
		padding: 8px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 42%, transparent);
		color: var(--color-ws-ink, #ECECF2);
		text-align: left;
		cursor: pointer;
	}

	.diff-page-row:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 44%, transparent);
	}

	.diff-page-row.selected {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 50%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 12%, transparent);
	}

	.diff-page-row.added {
		border-left: 3px solid var(--color-ws-green, #34D399);
	}

	.diff-page-row.removed {
		border-left: 3px solid var(--color-ws-rose, #FB7185);
	}

	.diff-page-name {
		overflow: hidden;
		font-size: 12px;
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.diff-page-status {
		color: var(--color-ws-text, #9A9AA8);
		font-size: 10px;
		font-weight: 700;
	}

	.diff-page-meta {
		grid-column: 1 / -1;
		color: var(--color-ws-text, #9A9AA8);
		font-size: 10px;
	}

	.diff-detail {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 9px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 28%, transparent);
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 8%, var(--color-ws-surface, #15151D));
	}

	.diff-detail-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		color: var(--color-ws-ink, #ECECF2);
		font-size: 12px;
	}

	.diff-mode-toggle {
		display: inline-flex;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl, 10px);
		overflow: hidden;
	}

	.diff-mode-btn {
		min-height: 36px;
		padding: 5px 9px;
		border: none;
		background: color-mix(in srgb, var(--color-ws-surface, #15151D) 42%, transparent);
		color: var(--color-ws-text, #9A9AA8);
		font-size: 11px;
		font-weight: 700;
		cursor: pointer;
	}

	.diff-mode-btn.active {
		background: color-mix(in srgb, var(--color-ws-accent, #7C5CFF) 22%, transparent);
		color: color-mix(in srgb, var(--color-ws-violet, #8B5CF6) 66%, var(--color-ws-ink, #ECECF2));
	}

	.diff-visual-split {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px;
	}

	.diff-visual-split figure {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 0;
	}

	.diff-visual-split figcaption {
		color: var(--color-ws-text, #9A9AA8);
		font-size: 10px;
		font-weight: 700;
	}

	.diff-visual-split img,
	.diff-no-image {
		width: 100%;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: var(--color-ws-bg, #0B0B0F);
		object-fit: contain;
		max-height: 320px;
	}

	.diff-no-image {
		display: grid;
		place-items: center;
		min-height: 120px;
		color: var(--color-ws-text, #9A9AA8);
		font-size: 11px;
	}

	.diff-visual-overlay {
		position: relative;
		display: grid;
	}

	.diff-overlay-base,
	.diff-overlay-target {
		grid-area: 1 / 1;
		width: 100%;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl, 10px);
		background: var(--color-ws-bg, #0B0B0F);
		object-fit: contain;
		max-height: 320px;
	}

	.diff-overlay-slider {
		grid-area: 1 / 1;
		align-self: end;
		width: 100%;
		margin: 6px 0;
		z-index: 2;
	}

	.diff-detail-actions {
		display: flex;
		gap: 6px;
	}

	.diff-layer-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.diff-layer-row {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 7px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card, 12px);
		background: color-mix(in srgb, var(--color-ws-surface2, #1C1C26) 42%, transparent);
	}

	.diff-layer-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}

	.diff-layer-kind {
		padding: 1px 6px;
		border: 1px solid var(--ws-hair);
		border-radius: 999px;
		color: var(--color-ws-text, #9A9AA8);
		font-size: 9px;
		font-weight: 800;
	}

	.diff-layer-name {
		overflow: hidden;
		flex: 1;
		min-width: 0;
		color: var(--color-ws-ink, #ECECF2);
		font-size: 11px;
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.diff-layer-changes {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.diff-change {
		padding: 1px 5px;
		border-radius: 999px;
		font-size: 9px;
		font-style: normal;
		font-weight: 800;
	}

	.diff-change-added {
		background: color-mix(in srgb, var(--color-ws-green, #34D399) 16%, transparent);
		color: var(--color-ws-green, #34D399);
	}

	.diff-change-removed {
		background: color-mix(in srgb, var(--color-ws-rose, #FB7185) 16%, transparent);
		color: var(--color-ws-rose, #FB7185);
	}

	.diff-change-edited,
	.diff-change-moved,
	.diff-change-restyled {
		background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 16%, transparent);
		color: var(--color-ws-amber, #FBBF24);
	}

	.diff-text-change {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: 11px;
	}

	.diff-text-change del {
		color: var(--color-ws-rose, #FB7185);
		text-decoration: line-through;
	}

	.diff-text-change ins {
		color: var(--color-ws-green, #34D399);
		text-decoration: none;
	}
</style>
