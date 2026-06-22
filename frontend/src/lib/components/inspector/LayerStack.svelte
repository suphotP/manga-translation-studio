<script lang="ts">
	/**
	 * LayerStack — extracted from LayersInspectorPanel.svelte (W0.7).
	 *
	 * Renders the unified "ลำดับเลเยอร์จริง" details/summary, optional
	 * filter chips, and the per-item rows (select button + quick actions).
	 * Behavior-preserving presentational atom: the orchestrator owns
	 * `unifiedLayerStackItems` (the source data shape), filter state,
	 * drag state, and decision logic for select/visibility/lock/move.
	 *
	 * Item shape is intentionally exported here as a structural type so
	 * the parent can pass an already-derived array without re-deriving it
	 * inside the child.
	 */

	import { _ } from "$lib/i18n";

	export type UnifiedLayerStackItemKind = "text" | "image";

	export interface UnifiedLayerStackItemShape {
		stackKey: string;
		id: string;
		kind: UnifiedLayerStackItemKind;
		title: string;
		meta: string;
		badge: string;
		isCredit: boolean;
		visible: boolean;
		locked: boolean;
		active: boolean;
		index: number;
		groupSize: number;
		stackIndex: number;
		stackSize: number;
	}

	export type UnifiedLayerStackFilterKey = "all" | "credit" | "text" | "image";

	interface FilterCounts {
		all: number;
		credit: number;
		text: number;
		image: number;
	}

	interface CanvasDimensions {
		width: number;
		height: number;
	}

	interface Props {
		filteredItems: UnifiedLayerStackItemShape[];
		totalItemCount: number;
		filterCounts: FilterCounts;
		filter: UnifiedLayerStackFilterKey;
		open: boolean;
		showFilter: boolean;
		selectedItemIncludedByFilter: boolean;
		selectedEditableLayerActive: boolean;
		summaryTitle: string;
		summaryHint: string;
		hasImage: boolean;
		canvasDimensions: CanvasDimensions;
		rowId: (item: UnifiedLayerStackItemShape) => string;
		onFilterChange: (filter: UnifiedLayerStackFilterKey) => void;
		onToggleOpen: (open: boolean) => void;
		onSelectItem: (item: UnifiedLayerStackItemShape) => void;
		onToggleItemVisibility: (item: UnifiedLayerStackItemShape) => void;
		onToggleItemLock: (item: UnifiedLayerStackItemShape) => void;
		onMoveItem: (item: UnifiedLayerStackItemShape, direction: -1 | 1) => void;
		onDragStart: (item: UnifiedLayerStackItemShape, event: DragEvent) => void;
		onDragOver: (event: DragEvent) => void;
		onDrop: (item: UnifiedLayerStackItemShape, event: DragEvent) => void;
	}

	let {
		filteredItems,
		totalItemCount,
		filterCounts,
		filter,
		open,
		showFilter,
		selectedItemIncludedByFilter,
		selectedEditableLayerActive,
		summaryTitle,
		summaryHint,
		hasImage,
		canvasDimensions,
		rowId,
		onFilterChange,
		onToggleOpen,
		onSelectItem,
		onToggleItemVisibility,
		onToggleItemLock,
		onMoveItem,
		onDragStart,
		onDragOver,
		onDrop,
	}: Props = $props();
</script>

<details
	class="unified-layer-stack"
	class:selected-layer-stack={selectedEditableLayerActive}
	role="region"
	aria-label={$_("layerStack.regionLabel")}
	{open}
	ontoggle={(event) => onToggleOpen((event.currentTarget as HTMLDetailsElement).open)}
>
	<summary
		class="unified-stack-summary"
		aria-label={selectedEditableLayerActive ? $_("layerStack.summaryOpenLabel") : $_("layerStack.summaryLabel")}
	>
		<div>
			<span>{$_("layerStack.summaryLabel")}</span>
			<strong title={summaryTitle}>{summaryTitle}</strong>
		</div>
		<small>{summaryHint}</small>
	</summary>
	{#if showFilter}
		<div class="unified-stack-filter" aria-label={$_("layerStack.filterLabel")}>
			<button
				type="button"
				class:active={filter === "all"}
				aria-pressed={filter === "all"}
				onclick={() => onFilterChange("all")}
			>{$_("layerStack.filterAll", { values: { n: filterCounts.all } })}</button>
			<button
				type="button"
				class:active={filter === "credit"}
				aria-pressed={filter === "credit"}
				onclick={() => onFilterChange("credit")}
			>{$_("layerStack.filterCredit", { values: { n: filterCounts.credit } })}</button>
			<button
				type="button"
				class:active={filter === "text"}
				aria-pressed={filter === "text"}
				onclick={() => onFilterChange("text")}
			>{$_("layerStack.filterText", { values: { n: filterCounts.text } })}</button>
			<button
				type="button"
				class:active={filter === "image"}
				aria-pressed={filter === "image"}
				onclick={() => onFilterChange("image")}
			>{$_("layerStack.filterImage", { values: { n: filterCounts.image } })}</button>
		</div>
		{#if filter !== "all"}
			<p class="unified-stack-filter-note">
				{$_("layerStack.filterNote", { values: { shown: filteredItems.length, total: totalItemCount, includesSelected: selectedItemIncludedByFilter ? $_("layerStack.filterNoteIncludesSelected") : "" } })}
			</p>
		{/if}
	{/if}
	<div class="unified-stack-list" role="list" aria-label={$_("layerStack.listLabel")}>
		{#each filteredItems as item (item.stackKey)}
			<div
				id={rowId(item)}
				class="unified-stack-row"
				class:active={item.active}
				class:hidden-layer={!item.visible}
				class:locked-layer={item.locked}
				draggable="true"
				ondragstart={(event) => onDragStart(item, event)}
				ondragover={onDragOver}
				ondrop={(event) => onDrop(item, event)}
				role="listitem"
			>
				<button
					type="button"
					class="unified-stack-select"
					onclick={() => onSelectItem(item)}
					aria-label={$_("layerStack.selectLayer", { values: { title: item.title } })}
					title={item.title}
				>
					<span
						class="unified-stack-badge"
						class:ai-badge={item.badge === "AI"}
						class:credit-badge={item.isCredit}
					>{item.badge}</span>
					<span class="unified-stack-copy">
						<strong>{item.title}</strong>
						<small>{item.meta}{!item.visible ? $_("layerStack.metaHiddenSuffix") : ""}{item.locked ? $_("layerStack.metaLockedSuffix") : ""}</small>
					</span>
				</button>
					{#if !(selectedEditableLayerActive && item.active)}
						<div class="unified-stack-actions" aria-label={$_("layerStack.quickActions", { values: { title: item.title } })}>
							<button
								type="button"
								class="unified-stack-action"
								onclick={() => onToggleItemVisibility(item)}
								aria-label={item.visible ? $_("layerStack.hideTitle", { values: { title: item.title } }) : $_("layerStack.showTitle", { values: { title: item.title } })}
								title={item.visible ? $_("layerStack.hideLayer") : $_("layerStack.showLayer")}
							>{item.visible ? $_("layerStack.visibleAction") : $_("layerStack.hiddenAction")}</button>
							<button
								type="button"
								class="unified-stack-action"
								onclick={() => onToggleItemLock(item)}
								aria-label={item.locked ? $_("layerStack.unlockTitle", { values: { title: item.title } }) : $_("layerStack.lockTitle", { values: { title: item.title } })}
								title={item.locked ? $_("layerStack.unlockLayer") : $_("layerStack.lockLayer")}
							>{item.locked ? $_("layerStack.unlockAction") : $_("layerStack.lockAction")}</button>
							{#if item.stackIndex < item.stackSize - 1}
								<button
									type="button"
									class="unified-stack-action"
									onclick={() => onMoveItem(item, 1)}
									aria-label={$_("layerStack.moveUpTitle", { values: { title: item.title } })}
									title={$_("layerStack.moveUp")}
								>{$_("layerStack.up")}</button>
							{:else}
								<span
									class="unified-stack-action unified-stack-action-receipt"
									aria-label={$_("layerStack.atTopTitle", { values: { title: item.title } })}
									title={$_("layerStack.atTop")}
								>{$_("layerStack.top")}</span>
							{/if}
							{#if item.stackIndex > 0}
								<button
									type="button"
									class="unified-stack-action"
									onclick={() => onMoveItem(item, -1)}
									aria-label={$_("layerStack.moveDownTitle", { values: { title: item.title } })}
									title={$_("layerStack.moveDown")}
								>{$_("layerStack.down")}</button>
							{:else}
								<span
									class="unified-stack-action unified-stack-action-receipt"
									aria-label={$_("layerStack.atBottomTitle", { values: { title: item.title } })}
									title={$_("layerStack.atBottom")}
								>{$_("layerStack.bottom")}</span>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		{#if filteredItems.length === 0}
			<div class="unified-stack-empty" role="status">{$_("layerStack.emptyFilter")}</div>
		{/if}
		<div class="unified-stack-row base" role="listitem" aria-label={$_("layerStack.baseRowLabel")}>
			<div class="unified-stack-select static">
				<span class="unified-stack-badge base-badge">{$_("layerStack.baseBadge")}</span>
				<span class="unified-stack-copy">
					<strong>{$_("layerStack.baseImage")}</strong>
					<small>{hasImage ? $_("layerStack.baseMeta", { values: { width: canvasDimensions.width, height: canvasDimensions.height } }) : $_("layerStack.noPageImage")}</small>
				</span>
			</div>
			<span class="unified-stack-lock">{$_("layerStack.original")}</span>
		</div>
	</div>
</details>

<style>
	/*
	 * Visual rules for `.unified-layer-stack`, `.unified-stack-*`, and
	 * the parent's `.layers-inspector.*` cascades that target
	 * `.unified-layer-stack` live in LayersInspectorPanel.svelte. Those
	 * selectors are wrapped in `:global()` there so this child can use
	 * the same class names without duplicating the visual rules.
	 *
	 * `.hidden-layer` and `.locked-layer` semantic state classes are
	 * also styled in the parent and shared globally.
	 */
</style>
