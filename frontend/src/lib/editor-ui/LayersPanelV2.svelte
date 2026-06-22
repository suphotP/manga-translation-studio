<script lang="ts">
	import { _ } from "$lib/i18n";

	export type LayerKind = "text" | "image" | "edit" | "base";

	export interface LayerPanelLayer {
		id: string;
		name: string;
		kind: LayerKind;
		kindLabel?: string;
		visible: boolean;
		locked: boolean;
		opacity: number;
		thumbnailUrl?: string;
	}

	export interface LayerSelectOptions {
		multi: boolean;
		index: number;
	}

	interface DragState {
		fromIndex: number;
		overIndex: number;
		pointerId: number | null;
	}

	interface Props {
		layers: LayerPanelLayer[];
		selectedIds: string[];
		onSelect: (id: string, options: LayerSelectOptions) => void;
		onToggleVisible: (id: string) => void;
		onToggleLock: (id: string) => void;
		onReorder: (dragIndex: number, toIndex: number) => void;
		onOpacity: (id: string, value: number) => void;
		onRename: (id: string, name: string) => void;
		onDelete: (id: string) => void;
		onRevert?: (id: string) => void;
	}

	let {
		layers,
		selectedIds,
		onSelect,
		onToggleVisible,
		onToggleLock,
		onReorder,
		onOpacity,
		onRename,
		onDelete,
		onRevert,
	}: Props = $props();

	let dragState = $state<DragState | null>(null);
	let renamingId = $state<string | null>(null);
	let renameDraft = $state("");

	function isSelected(id: string): boolean {
		return selectedIds.includes(id);
	}

	function isBaseLayer(layer: LayerPanelLayer): boolean {
		return layer.kind === "base";
	}

	function isImageEditLayer(layer: LayerPanelLayer): boolean {
		return layer.kind === "edit";
	}

	function canToggleVisible(layer: LayerPanelLayer): boolean {
		return !isBaseLayer(layer);
	}

	function canToggleLock(layer: LayerPanelLayer): boolean {
		return !isBaseLayer(layer) && !isImageEditLayer(layer);
	}

	function canReorderLayer(layer: LayerPanelLayer | undefined): layer is LayerPanelLayer {
		return Boolean(layer && !isBaseLayer(layer) && !isImageEditLayer(layer));
	}

	function canAdjustOpacity(layer: LayerPanelLayer): boolean {
		return !isBaseLayer(layer) && !isImageEditLayer(layer);
	}

	function canDeleteLayer(layer: LayerPanelLayer): boolean {
		return !isBaseLayer(layer);
	}

	function canRevertLayer(layer: LayerPanelLayer): boolean {
		return isImageEditLayer(layer) && typeof onRevert === "function";
	}

	function clampOpacity(value: number): number {
		if (!Number.isFinite(value)) return 1;
		return Math.min(1, Math.max(0, value));
	}

	function opacityPercent(layer: LayerPanelLayer): number {
		return Math.round(clampOpacity(layer.opacity) * 100);
	}

	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	function kindLabel(layer: LayerPanelLayer): string {
		if (layer.kindLabel?.trim()) return layer.kindLabel.trim();
		const kind = layer.kind;
		if (kind === "text") return msg("layersPanel.kindText", "ข้อความ");
		if (kind === "image") return msg("layersPanel.kindImage", "รูป");
		if (kind === "edit") return msg("layersPanel.kindEdit", "แก้ภาพ");
		return msg("layersPanel.kindBackground", "พื้นหลัง");
	}

	function kindGlyph(kind: LayerKind): string {
		if (kind === "text") return "T";
		if (kind === "image") return "IMG";
		if (kind === "edit") return "FX";
		return "BG";
	}

	function statusText(layer: LayerPanelLayer): string {
		const flags = [
			kindLabel(layer),
			layer.visible ? msg("layersPanel.visible", "มองเห็น") : msg("layersPanel.hidden", "ซ่อนอยู่"),
		];
		if (!isImageEditLayer(layer)) {
			flags.push(layer.locked ? msg("layersPanel.locked", "ล็อก") : msg("layersPanel.editable", "แก้ได้"));
			flags.push(`${opacityPercent(layer)}%`);
		}
		return flags.join(" / ");
	}

	function selectLayer(layer: LayerPanelLayer, index: number, event: MouseEvent): void {
		onSelect(layer.id, { multi: event.shiftKey, index });
	}

	function startRename(layer: LayerPanelLayer): void {
		if (isBaseLayer(layer)) return;
		renamingId = layer.id;
		renameDraft = layer.name;
	}

	function commitRename(layer: LayerPanelLayer): void {
		const nextName = renameDraft.trim();
		renamingId = null;
		renameDraft = "";

		// Empty names make the stack unusable in long chapters, so keep the old label.
		if (!nextName || nextName === layer.name) return;
		onRename(layer.id, nextName);
	}

	function cancelRename(): void {
		renamingId = null;
		renameDraft = "";
	}

	function handleRenameKeydown(layer: LayerPanelLayer, event: KeyboardEvent): void {
		if (event.key === "Enter") {
			event.preventDefault();
			commitRename(layer);
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			cancelRename();
		}
	}

	function handleOpacity(layer: LayerPanelLayer, event: Event): void {
		// Locked layers stay read-only here, matching the legacy inspector —
		// updateImageLayer does not re-check locks itself (codex P2).
		if (layer.locked || !canAdjustOpacity(layer)) return;
		const raw = Number((event.currentTarget as HTMLInputElement).value);
		onOpacity(layer.id, Math.min(1, Math.max(0, raw / 100)));
	}

	function beginDrag(layer: LayerPanelLayer, index: number, event: PointerEvent): void {
		if (!canReorderLayer(layer)) return;
		event.preventDefault();
		event.stopPropagation();
		dragState = {
			fromIndex: index,
			overIndex: index,
			pointerId: Number.isFinite(event.pointerId) ? event.pointerId : null,
		};
	}

	function enterDragTarget(index: number, event: PointerEvent): void {
		if (!dragState) return;
		if (dragState.pointerId !== null && event.pointerId !== dragState.pointerId) return;
		dragState = { ...dragState, overIndex: index };
	}

	function finishDrag(toIndex: number, event?: PointerEvent): void {
		if (!dragState) return;
		if (event && dragState.pointerId !== null && event.pointerId !== dragState.pointerId) return;

		const { fromIndex, overIndex } = dragState;
		const targetIndex = Number.isInteger(toIndex) ? toIndex : overIndex;
		dragState = null;

		// The parent owns ordering; this component only reports a stable index move.
		if (fromIndex === targetIndex) return;
		if (fromIndex < 0 || targetIndex < 0) return;
		if (fromIndex >= layers.length || targetIndex >= layers.length) return;
		// Non-reorderable rows are not valid drop targets. Clamp the drop to
		// the nearest editable stack row instead of rejecting the whole drag.
		if (!canReorderLayer(layers[fromIndex])) return;
		let clamped = targetIndex;
		while (clamped >= 0 && !canReorderLayer(layers[clamped])) clamped -= 1;
		if (clamped < 0 || clamped === fromIndex) return;
		onReorder(fromIndex, clamped);
	}

	function finishDragFromPanel(event: PointerEvent): void {
		if (!dragState) return;
		finishDrag(dragState.overIndex, event);
	}

	/** Svelte action: focus + select the rename input the moment it mounts. */
	function focusAndSelect(node: HTMLInputElement): void {
		node.focus();
		node.select();
	}

	function cancelDrag(): void {
		dragState = null;
	}
</script>

<section class="layers-panel-v2 ws-sans bg-ws-surface/80 text-ws-ink" aria-label={msg("layersPanel.panelAria", "เลเยอร์")}>
	<div class="panel-heading">
		<div>
			<p>Layer stack</p>
			<strong>{msg("layersPanel.orderTitle", "ลำดับเลเยอร์")}</strong>
		</div>
		<span>{msg("layersPanel.layerCount", "{n} ชั้น").replace("{n}", String(layers.length))}</span>
	</div>

	{#if layers.length === 0}
		<div class="empty-stack" role="status">{msg("layersPanel.emptyStack", "ยังไม่มีเลเยอร์ในหน้านี้")}</div>
	{:else}
		<div
			class="layer-list"
			role="list"
			aria-label={msg("layersPanel.orderTitle", "ลำดับเลเยอร์")}
			onpointerup={finishDragFromPanel}
			onpointercancel={cancelDrag}
		>
			{#each layers as layer, index (layer.id)}
				{@const selected = isSelected(layer.id)}
				<div
					class="layer-item"
					class:selected
					class:hidden-layer={!layer.visible}
					class:locked-layer={layer.locked}
					class:dragging={dragState?.fromIndex === index}
					class:drop-target={dragState?.overIndex === index && dragState?.fromIndex !== index}
					role="listitem"
					data-testid={`layer-row-${layer.id}`}
					data-layer-index={index}
					onpointerenter={(event) => enterDragTarget(index, event)}
					onpointerup={(event) => finishDrag(index, event)}
				>
					<div class="layer-row">
						<button
							type="button"
							class="drag-handle"
							aria-label={msg("layersPanel.dragSort", "ลากเรียง {name}").replace("{name}", layer.name)}
							title={msg("layersPanel.dragHint", "ลากเพื่อสลับลำดับ")}
							disabled={!canReorderLayer(layer)}
							onpointerdown={(event) => beginDrag(layer, index, event)}
						>
							<span aria-hidden="true">⋮⋮</span>
						</button>

						{#if renamingId === layer.id}
							<!-- Rename swaps the WHOLE row button for a non-interactive shell:
							     an input nested inside a button is invalid AND never receives
							     focus, so typing right after the dblclick did nothing (codex
							     P2). The action below focuses + selects on entry. -->
							<div class="layer-main renaming">
								<span class="layer-thumb" aria-hidden="true">
									{#if layer.thumbnailUrl}
										<img src={layer.thumbnailUrl} alt="" draggable="false" />
									{:else}
										<span>{kindGlyph(layer.kind)}</span>
									{/if}
								</span>
								<span class="layer-copy">
									<input
										class="rename-input"
										aria-label={msg("layersPanel.renameAria", "เปลี่ยนชื่อเลเยอร์ {name}").replace("{name}", layer.name)}
										value={renameDraft}
										use:focusAndSelect
										oninput={(event) => (renameDraft = (event.currentTarget as HTMLInputElement).value)}
										onkeydown={(event) => handleRenameKeydown(layer, event)}
										onblur={() => commitRename(layer)}
										onclick={(event) => event.stopPropagation()}
									/>
								</span>
							</div>
						{:else}
							<button
								type="button"
								class="layer-main"
								aria-label={msg("layersPanel.selectAria", "เลือกเลเยอร์ {name}").replace("{name}", layer.name)}
								aria-pressed={selected}
								onclick={(event) => selectLayer(layer, index, event)}
								ondblclick={() => startRename(layer)}
							>
								<span class="layer-thumb" aria-hidden="true">
									{#if layer.thumbnailUrl}
										<img src={layer.thumbnailUrl} alt="" draggable="false" />
									{:else}
										<span>{kindGlyph(layer.kind)}</span>
									{/if}
								</span>
								<span class="layer-copy">
									<strong>{layer.name}</strong>
									<small>{statusText(layer)}</small>
								</span>
							</button>
						{/if}

						<div class="layer-actions" aria-label={msg("layersPanel.actionsAria", "คำสั่ง {name}").replace("{name}", layer.name)}>
							<button
								type="button"
								class="icon-action"
								aria-label={(layer.visible ? msg("layersPanel.hideAria", "ซ่อน {name}") : msg("layersPanel.showAria", "แสดง {name}")).replace("{name}", layer.name)}
								title={layer.visible ? msg("layersPanel.hide", "ซ่อน") : msg("layersPanel.show", "แสดง")}
								disabled={!canToggleVisible(layer)}
								onclick={() => onToggleVisible(layer.id)}
							>
								{layer.visible ? msg("layersPanel.seen", "เห็น") : msg("layersPanel.hiddenShort", "ซ่อน")}
							</button>
							<button
								type="button"
								class="icon-action"
								aria-label={(layer.locked ? msg("layersPanel.unlockAria", "ปลดล็อก {name}") : msg("layersPanel.lockAria", "ล็อก {name}")).replace("{name}", layer.name)}
								title={layer.locked ? msg("layersPanel.unlock", "ปลดล็อก") : msg("layersPanel.lock", "ล็อก")}
								disabled={!canToggleLock(layer)}
								onclick={() => onToggleLock(layer.id)}
							>
								{layer.locked ? msg("layersPanel.lock", "ล็อก") : msg("layersPanel.openShort", "เปิด")}
							</button>
							{#if isImageEditLayer(layer)}
								<button
									type="button"
									class="icon-action"
									aria-label={msg("layersInspector.revertBeforeEditAria", "ย้อนกลับไปก่อนการแก้นี้")}
									title={msg("layersInspector.revertBeforeEditTooltip", "ย้อนกลับไปก่อนการแก้นี้")}
									disabled={!canRevertLayer(layer)}
									onclick={() => onRevert?.(layer.id)}
								>
									{msg("layersInspector.actionRevert", "ย้อน")}
								</button>
							{/if}
							<button
								type="button"
								class="icon-action danger"
								aria-label={msg("layersPanel.deleteAria", "ลบ {name}").replace("{name}", layer.name)}
								title={msg("layersPanel.delete", "ลบ")}
								disabled={!canDeleteLayer(layer)}
								onclick={() => onDelete(layer.id)}
							>
								{msg("layersPanel.delete", "ลบ")}
							</button>
						</div>
					</div>

					{#if selected && canAdjustOpacity(layer)}
						<label class="opacity-control" for={`layer-opacity-${layer.id}`}>
							<span>{msg("layersPanel.opacity", "ความทึบ")}</span>
							<input
								id={`layer-opacity-${layer.id}`}
								type="range"
								min="0"
								max="100"
								step="1"
								value={opacityPercent(layer)}
								disabled={layer.locked}
								aria-label={msg("layersPanel.opacityAria", "ความทึบของ {name}").replace("{name}", layer.name)}
								oninput={(event) => handleOpacity(layer, event)}
							/>
							<strong>{opacityPercent(layer)}%</strong>
						</label>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</section>

<style>
	.layers-panel-v2 {
		display: grid;
		gap: 8px;
		width: 100%;
		min-width: 0;
		padding: 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-line) 14%, transparent);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-ws-surface) 86%, transparent);
		color: var(--color-ws-ink);
		font-family: var(--font-ws-sans);
	}

	.panel-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
	}

	.panel-heading div {
		display: grid;
		min-width: 0;
		gap: 1px;
	}

	.panel-heading p,
	.panel-heading strong,
	.panel-heading span {
		margin: 0;
		line-height: 1.15;
	}

	.panel-heading p {
		color: var(--color-ws-cyan);
		font-size: 10px;
		font-weight: 850;
	}

	.panel-heading strong {
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 900;
	}

	.panel-heading span {
		flex: none;
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 780;
	}

	.layer-list {
		display: grid;
		gap: 5px;
	}

	.layer-item {
		display: grid;
		gap: 5px;
		min-width: 0;
		border: 1px solid color-mix(in srgb, var(--color-ws-line) 10%, transparent);
		border-radius: 7px;
		background: color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
		transition: background 0.14s ease, border-color 0.14s ease, opacity 0.14s ease;
	}

	.layer-item.selected {
		border-color: color-mix(in srgb, var(--color-ws-accent) 50%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 13%, transparent);
	}

	.layer-item.hidden-layer {
		opacity: 0.58;
	}

	.layer-item.locked-layer .layer-row {
		background: color-mix(in srgb, var(--color-ws-ink) 2%, transparent);
	}

	.layer-item.dragging {
		border-color: color-mix(in srgb, var(--color-ws-cyan) 52%, transparent);
		background: color-mix(in srgb, var(--color-ws-cyan) 10%, transparent);
	}

	.layer-item.drop-target {
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-ws-amber) 48%, transparent);
	}

	.layer-row {
		display: grid;
		grid-template-columns: 24px minmax(0, 1fr) auto;
		align-items: center;
		gap: 5px;
		height: 36px;
		min-height: 36px;
		padding: 3px 5px;
	}

	.drag-handle,
	.icon-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 28px;
		min-width: 24px;
		padding: 0 5px;
		border: 1px solid color-mix(in srgb, var(--color-ws-line) 12%, transparent);
		border-radius: 5px;
		background: color-mix(in srgb, var(--color-ws-ink) 4%, transparent);
		color: var(--color-ws-text);
		font-family: inherit;
		font-size: 9px;
		font-weight: 820;
		line-height: 1;
		cursor: pointer;
	}

	.drag-handle:hover,
	.icon-action:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 42%, transparent);
		color: var(--color-ws-ink);
	}

	.drag-handle:disabled {
		opacity: 0.32;
		cursor: default;
	}

	.icon-action:disabled {
		opacity: 0.3;
		cursor: default;
	}

	.icon-action.danger {
		color: #fecaca;
	}

	.icon-action.danger:hover {
		border-color: rgba(248, 113, 113, 0.46);
		color: #fee2e2;
	}

	.icon-action.danger:disabled {
		opacity: 0.3;
		cursor: default;
	}

	.drag-handle span {
		transform: translateY(-1px);
	}

	.layer-main {
		display: grid;
		grid-template-columns: 30px minmax(0, 1fr);
		align-items: center;
		gap: 7px;
		min-width: 0;
		height: 30px;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		font-family: inherit;
		text-align: left;
		cursor: pointer;
	}

	.layer-thumb {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 26px;
		overflow: hidden;
		border: 1px solid color-mix(in srgb, var(--color-ws-line) 16%, transparent);
		border-radius: 5px;
		background: color-mix(in srgb, var(--color-ws-bg) 72%, transparent);
		color: var(--color-ws-cyan);
		font-size: 8px;
		font-weight: 900;
	}

	.layer-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.layer-copy {
		display: grid;
		min-width: 0;
		gap: 1px;
	}

	.layer-copy strong,
	.layer-copy small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.layer-copy strong {
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 850;
	}

	.layer-copy small {
		color: var(--color-ws-text);
		font-size: 9px;
		font-weight: 700;
	}

	.rename-input {
		width: 100%;
		min-width: 0;
		height: 26px;
		padding: 0 7px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 42%, transparent);
		border-radius: 5px;
		background: color-mix(in srgb, var(--color-ws-bg) 92%, transparent);
		color: var(--color-ws-ink);
		font: inherit;
		font-size: 11px;
		font-weight: 760;
	}

	.layer-actions {
		display: inline-flex;
		align-items: center;
		gap: 3px;
	}

	.opacity-control {
		display: grid;
		grid-template-columns: auto minmax(72px, 1fr) 34px;
		align-items: center;
		gap: 7px;
		min-width: 0;
		padding: 0 7px 6px 36px;
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 780;
	}

	.opacity-control input {
		width: 100%;
		min-width: 0;
		accent-color: var(--color-ws-accent);
	}

	.opacity-control strong {
		color: var(--color-ws-ink);
		font-size: 10px;
		font-weight: 860;
		text-align: right;
	}

	.empty-stack {
		display: flex;
		align-items: center;
		min-height: 36px;
		padding: 0 8px;
		border: 1px dashed color-mix(in srgb, var(--color-ws-line) 16%, transparent);
		border-radius: 6px;
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 760;
	}
</style>
