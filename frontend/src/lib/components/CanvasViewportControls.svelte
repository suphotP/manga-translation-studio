<script lang="ts">
	import { _ } from "$lib/i18n";

	interface Props {
		zoom: number;
		unavailable?: boolean;
		zIndex?: number;
		onZoomOut: () => void;
		onReset: () => void;
		onZoomIn: () => void;
	}

	let {
		zoom,
		unavailable = false,
		zIndex = 190,
		onZoomOut,
		onReset,
		onZoomIn,
	}: Props = $props();

	let zoomLabel = $derived(`${Math.round(zoom * 100)}%`);
</script>

<section class="viewport-controls ws-sans ws-panel" style={`z-index:${zIndex};`} aria-label={$_("canvasViewportControls.groupLabel")}>
	{#if unavailable}
		<span class="viewport-receipt" aria-label={$_("canvasViewportControls.zoomOutUnavailable")}>-</span>
		<span class="zoom-readout viewport-receipt" aria-label={$_("canvasViewportControls.zoomUnavailable", { values: { zoom: zoomLabel } })} aria-live="polite">
			{zoomLabel}
		</span>
		<span class="viewport-receipt" aria-label={$_("canvasViewportControls.zoomInUnavailable")}>+</span>
	{:else}
		<button type="button" class="ws-btn-ghost" aria-label={$_("canvasViewportControls.zoomOut")} title={$_("canvasViewportControls.zoomOut")} onclick={onZoomOut}>-</button>
		<button
			type="button"
			class="zoom-readout ws-btn-ghost"
			aria-label={$_("canvasViewportControls.resetFrom", { values: { zoom: zoomLabel } })}
			aria-live="polite"
			title={$_("canvasViewportControls.resetZoom")}
			onclick={onReset}
		>
			{zoomLabel}
		</button>
		<button type="button" class="ws-btn-ghost" aria-label={$_("canvasViewportControls.zoomIn")} title={$_("canvasViewportControls.zoomIn")} onclick={onZoomIn}>+</button>
	{/if}
</section>

<style>
	.viewport-controls {
		position: absolute;
		right: 12px;
		bottom: 12px;
		display: grid;
		grid-template-columns: 40px minmax(60px, auto) 40px;
		overflow: hidden;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface) 92%, transparent);
		box-shadow: 0 1px 0 color-mix(in srgb, var(--color-ws-ink) 3%, transparent) inset, 0 14px 40px -28px color-mix(in srgb, var(--color-ws-bg) 90%, transparent);
		color: var(--color-ws-ink);
		pointer-events: auto;
		user-select: none;
	}

	button,
	.viewport-receipt {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 0;
		min-height: 40px;
		padding: 0 8px;
		border: 0;
		border-right: 1px solid var(--ws-hair);
		border-radius: 0;
		background: color-mix(in srgb, var(--color-ws-surface2) 40%, transparent);
		color: inherit;
		cursor: pointer;
		font: inherit;
		font-size: 15px;
		font-weight: 850;
		line-height: 1;
		touch-action: manipulation;
	}

	button:last-child,
	.viewport-receipt:last-child {
		border-right: 0;
	}

	button:hover,
	button:focus-visible {
		background: color-mix(in srgb, var(--color-ws-accent) 18%, var(--color-ws-surface2));
		color: var(--color-ws-ink);
		outline: none;
	}

	.viewport-receipt {
		cursor: default;
		opacity: 0.45;
	}

	.zoom-readout {
		color: var(--color-ws-blue);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0;
	}

	@media (max-width: 860px) {
		.viewport-controls {
			grid-template-columns: 40px minmax(64px, auto) 40px;
		}

		button,
		.viewport-receipt {
			min-height: 40px;
			font-size: 16px;
		}
	}

	@media (min-width: 861px) and (max-width: 1040px) {
		.viewport-controls {
			grid-template-columns: 40px minmax(64px, auto) 40px;
		}

		button,
		.viewport-receipt {
			min-height: 40px;
			font-size: 16px;
		}
	}

	@media (pointer: coarse) {
		.viewport-controls {
			right: max(12px, env(safe-area-inset-right));
			bottom: max(12px, env(safe-area-inset-bottom));
			grid-template-columns: 46px minmax(72px, auto) 46px;
			border-radius: var(--radius-ws-ctrl);
		}

		button,
		.viewport-receipt {
			min-height: 46px;
			padding: 0 10px;
			font-size: 17px;
		}

		.zoom-readout {
			font-size: 12px;
		}
	}
</style>
