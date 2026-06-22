<script lang="ts">
	/**
	 * LayerDeleteDialog — extracted from LayersInspectorPanel.svelte (W0.3).
	 *
	 * Behavior-preserving presentational atom. All state and decision logic
	 * (which kind of delete is pending, how it gets confirmed) stays in the
	 * orchestrator. This component only renders the confirmation modal and
	 * forwards user intent through callback props.
	 *
	 * A11y: built on the shared ui/Dialog atom (role="alertdialog"), so it gets
	 * Escape-to-cancel, a focus trap, focus restore to the opener, and an inert
	 * background for free. Strings localise via svelte-i18n (Thai fallback).
	 */

	import Dialog from "$lib/components/ui/Dialog.svelte";
	import { _ } from "$lib/i18n";

	function t(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}

	interface PendingDeleteCopy {
		title: string;
		detail: string;
	}

	interface Props {
		pendingDeleteAction: PendingDeleteCopy | null;
		onConfirm: () => void;
		onCancel: () => void;
	}

	let {
		pendingDeleteAction,
		onConfirm,
		onCancel,
	}: Props = $props();
</script>

<Dialog
	open={!!pendingDeleteAction}
	onClose={onCancel}
	role="alertdialog"
	size="sm"
	showClose={false}
	ariaLabel={pendingDeleteAction?.title ?? t("layerDelete.confirmEyebrow", "ยืนยันก่อนลบ")}
	ariaDescribedby="layer-delete-dialog-detail"
	panelClass="layer-delete-panel"
>
	{#if pendingDeleteAction}
		<div class="layer-delete-copy">
			<small>{t("layerDelete.confirmEyebrow", "ยืนยันก่อนลบ")}</small>
			<strong id="layer-delete-dialog-title">{pendingDeleteAction.title}</strong>
			<span id="layer-delete-dialog-detail">{pendingDeleteAction.detail}</span>
		</div>
	{/if}

	{#snippet footer()}
		<div class="layer-delete-actions">
			<button type="button" class="panel-btn" onclick={onCancel}>
				{t("layerDelete.cancel", "ยกเลิก")}
			</button>
			<button type="button" class="panel-btn danger-soft" onclick={onConfirm}>
				{t("layerDelete.confirm", "ลบเลย")}
			</button>
		</div>
	{/snippet}
</Dialog>

<style>
	:global(.ws-dialog-panel.layer-delete-panel) {
		border: 1px solid rgba(251, 113, 133, 0.32);
		background: linear-gradient(135deg, rgba(42, 16, 24, 0.98), var(--color-ws-surface, #15151d) 70%);
	}

	.layer-delete-copy {
		display: grid;
		gap: 6px;
	}

	.layer-delete-copy small {
		color: var(--color-ws-rose, #fb7185);
		font-size: 10px;
		font-weight: 900;
	}

	.layer-delete-copy strong {
		color: var(--color-ws-ink, #fff7f4);
		font-size: 15px;
		font-weight: 920;
	}

	.layer-delete-copy span {
		color: var(--editor-text-muted);
		font-size: 12px;
		font-weight: 720;
		line-height: 1.45;
	}

	.layer-delete-actions {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
		width: 100%;
	}

	.layer-delete-actions :global(.panel-btn) {
		min-height: 42px;
	}

	.danger-soft {
		border-color: rgba(251, 113, 133, 0.32);
		color: #ffc2d5;
	}

	.danger-soft:hover {
		border-color: rgba(251, 113, 133, 0.6);
		background: rgba(251, 113, 133, 0.12);
		color: #ffd8e6;
	}
</style>
