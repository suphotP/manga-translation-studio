<script lang="ts">
	import { _ } from "$lib/i18n";
	import type { TaskFocusItem } from "$lib/project/task-focus-queue.js";
	import type { WorkInboxItem } from "$lib/project/work-inbox.js";
	import { signedAssetSrc, type SignedAssetSrcParams } from "$lib/actions/signedAssetSrc.ts";

	interface BlockerVisualPreview {
		pageLabel: string;
		title: string;
		detail: string;
		previewUrl: string | null;
		previewParams: SignedAssetSrcParams | null;
		imageName: string;
		regionStyle: string | null;
	}

	interface Props {
		topBlockerItem: TaskFocusItem | WorkInboxItem | null;
		topBlockerVisual: BlockerVisualPreview | null;
		workItemDisplayTitle: (item: TaskFocusItem | WorkInboxItem | null) => string;
		workItemRouteLabel: (item: TaskFocusItem | WorkInboxItem | null) => string;
		blockerOwnerLabel: (item: TaskFocusItem | WorkInboxItem | null) => string;
		workPrimaryActionLabel: (item: TaskFocusItem | WorkInboxItem | null) => string;
		workItemCanvasActionLabel: (item: TaskFocusItem | WorkInboxItem | null) => string;
		onFocusTopBlocker: () => void;
		onOpenTopBlocker: () => void;
		onCopyFocusLink: (item: TaskFocusItem | WorkInboxItem | null) => void;
		onMarkBlockerPreviewFailed: (preview: BlockerVisualPreview) => void;
	}

	let {
		topBlockerItem,
		topBlockerVisual,
		workItemDisplayTitle,
		workItemRouteLabel,
		blockerOwnerLabel,
		workPrimaryActionLabel,
		workItemCanvasActionLabel,
		onFocusTopBlocker,
		onOpenTopBlocker,
		onCopyFocusLink,
		onMarkBlockerPreviewFailed,
	}: Props = $props();

	// Route the preview-load failure through signedAssetSrc's onFailed (called only
	// AFTER its token re-mint retry) instead of a raw <img onerror>, which aborts
	// the re-sign on the first error and leaves an expired-token preview broken.
	let blockerPreviewParams = $derived<SignedAssetSrcParams | null>(
		topBlockerVisual?.previewParams
			? { ...topBlockerVisual.previewParams, onFailed: () => topBlockerVisual && onMarkBlockerPreviewFailed(topBlockerVisual) }
			: null,
	);
</script>

{#if topBlockerItem}
	<section class="solo-blocker-strip active ws-panel" aria-label={$_("workBoard.soloBlockerAria")}>
		<div class="solo-blocker-layout">
			{#if topBlockerVisual}
				<button
					type="button"
					class="blocker-visual-preview ws-panel-quiet"
					aria-label={$_("workBoard.blockerPreviewAria", { values: { page: topBlockerVisual.pageLabel } })}
					onclick={onOpenTopBlocker}
				>
					<span class="blocker-page-frame" aria-hidden="true">
						{#if topBlockerVisual.previewUrl && blockerPreviewParams}
							<img
								use:signedAssetSrc={blockerPreviewParams}
								alt=""
							/>
						{:else}
							<span class="blocker-preview-placeholder">{topBlockerVisual.pageLabel}</span>
						{/if}
						{#if topBlockerVisual.regionStyle}
							<i class="blocker-region-target" style={topBlockerVisual.regionStyle}></i>
						{/if}
					</span>
					<span class="blocker-preview-copy">
						<strong>{topBlockerVisual.pageLabel}</strong>
						<small>{topBlockerVisual.title} / {topBlockerVisual.detail}</small>
					</span>
				</button>
			{/if}
			<div class="solo-blocker-copy">
				<span>{$_("workBoard.firstWorkToday")}</span>
				<strong>{workItemDisplayTitle(topBlockerItem)}</strong>
				<small>{$_("workBoard.exportStuckHere")} / {workItemRouteLabel(topBlockerItem)} / {blockerOwnerLabel(topBlockerItem)}</small>
			</div>
		</div>
		<div class="solo-blocker-actions">
			<button type="button" class="primary ws-grad-primary" onclick={onFocusTopBlocker}>
				{workPrimaryActionLabel(topBlockerItem)}
			</button>
			<details class="work-row-more">
				<summary class="ws-btn-ghost">{$_("workBoard.more")}</summary>
				<div class="work-row-more-menu">
					<button type="button" class="ws-btn-ghost" onclick={onOpenTopBlocker}>
						{workItemCanvasActionLabel(topBlockerItem)}
					</button>
					<button type="button" class="ws-btn-ghost" onclick={() => onCopyFocusLink(topBlockerItem)}>
						{$_("workBoard.copyLink")}
					</button>
				</div>
			</details>
		</div>
	</section>
{/if}

<style>
	.solo-blocker-strip {
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 28%, transparent);
		border-radius: var(--radius-ws-card);
		background:
			linear-gradient(
				90deg,
				color-mix(in srgb, var(--color-ws-amber) 14%, transparent),
				color-mix(in srgb, var(--color-ws-surface2) 86%, transparent)
			),
			color-mix(in srgb, var(--color-ws-surface) 82%, transparent);
		color: var(--color-ws-ink);
	}

	.blocker-visual-preview {
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 28%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background:
			linear-gradient(
				135deg,
				color-mix(in srgb, var(--color-ws-amber) 12%, transparent),
				color-mix(in srgb, var(--color-ws-accent) 7%, transparent)
			),
			color-mix(in srgb, var(--color-ws-bg) 48%, transparent);
		color: inherit;
	}

	.blocker-page-frame {
		border: 1px solid var(--ws-hair-strong);
		border-radius: calc(var(--radius-ws-ctrl) - 4px);
		background: color-mix(in srgb, var(--color-ws-surface2) 88%, transparent);
	}

	.blocker-preview-placeholder,
	.blocker-preview-copy strong,
	.solo-blocker-copy strong {
		color: var(--color-ws-ink);
	}

	.blocker-preview-copy small,
	.solo-blocker-copy small {
		color: var(--color-ws-text);
	}

	.blocker-region-target {
		border-color: var(--color-ws-amber);
		border-radius: calc(var(--radius-ws-ctrl) / 2);
		background: color-mix(in srgb, var(--color-ws-amber) 20%, transparent);
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--color-ws-bg) 72%, transparent),
			0 0 18px color-mix(in srgb, var(--color-ws-amber) 34%, transparent);
	}

	.solo-blocker-copy span {
		color: var(--color-ws-amber);
	}

	.solo-blocker-actions button,
	.work-row-more summary,
	.work-row-more-menu button {
		min-height: 38px;
		border-radius: var(--radius-ws-ctrl);
		border: 1px solid var(--ws-hair);
		color: var(--color-ws-ink);
		font-family: inherit;
	}

	.solo-blocker-actions button.primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 52%, transparent);
	}

	.work-row-more[open] summary,
	.work-row-more-menu {
		border-color: color-mix(in srgb, var(--color-ws-accent) 35%, transparent);
		background: var(--color-ws-surface);
	}
</style>
