<script lang="ts">
	import { _ } from "$lib/i18n";
	import {
		CANVAS_WORK_OVERLAY_KINDS,
		CANVAS_WORK_OVERLAY_META,
		getCanvasOverlayZIndex,
		CANVAS_CHROME_OVERLAY_SWATCHES,
		type CanvasOverlayVisibility,
		type CanvasWorkOverlayKind,
	} from "$lib/editor/overlay-priority.js";

	interface Props {
		counts: Record<CanvasWorkOverlayKind, number>;
		visibility: CanvasOverlayVisibility;
		interactive: boolean;
		suppressed?: boolean;
		compact?: boolean;
		quiet?: boolean;
		onToggle: (kind: CanvasWorkOverlayKind) => void;
	}

	let { counts, visibility, interactive, suppressed = false, compact = false, quiet = false, onToggle }: Props = $props();
	let expanded = $state(false);
	let legendExpanded = $state(false);

	let totalCount = $derived(
		CANVAS_WORK_OVERLAY_KINDS.reduce((sum, kind) => sum + counts[kind], 0)
	);
	let visibleKinds = $derived(CANVAS_WORK_OVERLAY_KINDS.filter((kind) => counts[kind] > 0));
	let activeSummary = $derived(buildActiveSummary($_));

	function swatchClass(kind: CanvasWorkOverlayKind): string {
		return `overlay-swatch ${kind}`;
	}

	// Localized display labels derived purely from the stable overlay KIND code.
	function kindLabel(kind: CanvasWorkOverlayKind): string {
		return $_(`canvasOverlay.kind.${kind}`);
	}

	function kindShortLabel(kind: CanvasWorkOverlayKind): string {
		return $_(`canvasOverlay.shortLabel.${kind}`);
	}

	function kindDescription(kind: CanvasWorkOverlayKind): string {
		return $_(`canvasOverlay.description.${kind}`);
	}

	function buildActiveSummary(t: typeof $_): string {
		return CANVAS_WORK_OVERLAY_KINDS
			.filter((kind) => counts[kind] > 0)
			.map((kind) => t(`canvasOverlay.shortLabel.${kind}`))
			.join(" / ");
	}
</script>

{#if totalCount > 0}
	<section
		class="overlay-controls ws-sans ws-panel"
		class:inactive={!interactive}
		class:suppressed
		class:compact
		class:quiet
		style={`z-index:${getCanvasOverlayZIndex("overlay-controls")};`}
		aria-label={$_("canvasOverlay.filterAria")}
	>
		<div class="overlay-controls-head">
			<span>{suppressed ? $_("canvasOverlay.suppressedHead") : $_("canvasOverlay.filterHead")}</span>
			<strong>{totalCount}</strong>
		</div>
		{#if suppressed}
			<div class="overlay-suppressed-chip" aria-label={$_("canvasOverlay.suppressedChipAria")}>
				<span>{quiet ? $_("canvasOverlay.hideShort") : $_("canvasOverlay.hidden")}</span>
				<strong>{totalCount}</strong>
				{#if !quiet}
					<small>{activeSummary}</small>
				{/if}
			</div>
		{:else if compact && !expanded}
			<button
				type="button"
				class="overlay-summary-button ws-btn-ghost"
				aria-label={$_("canvasOverlay.summaryAria", { values: { count: totalCount, summary: activeSummary } })}
				onclick={() => expanded = true}
			>
				<span>{quiet ? $_("canvasOverlay.summaryWork") : $_("canvasOverlay.summaryCheck")}</span>
				<strong>{totalCount}</strong>
				{#if !quiet}
					<small>{activeSummary}</small>
				{/if}
			</button>
		{:else}
			<div
				class="overlay-toggle-grid"
				style={`grid-template-columns: repeat(${Math.max(1, visibleKinds.length)}, minmax(0, 1fr));`}
			>
				{#each visibleKinds as kind (kind)}
					<button
						type="button"
						class="overlay-toggle ws-btn-ghost"
						class:active={visibility[kind]}
						aria-pressed={visibility[kind]}
						aria-label={$_("canvasOverlay.toggleAria", { values: { action: visibility[kind] ? $_("canvasOverlay.hide") : $_("canvasOverlay.show"), kind: kindLabel(kind) } })}
						title={kindDescription(kind)}
						onclick={() => onToggle(kind)}
					>
						<span class={swatchClass(kind)}></span>
						<span class="overlay-label">{kindShortLabel(kind)}</span>
						<strong>{counts[kind]}</strong>
					</button>
				{/each}
			</div>
			{#if compact}
				<button
					type="button"
					class="overlay-collapse-button ws-btn-ghost"
					aria-label={$_("canvasOverlay.collapseAria")}
					onclick={() => expanded = false}
				>
					{$_("canvasOverlay.collapse")}
				</button>
			{/if}

			<button
				type="button"
				class="legend-toggle ws-btn-ghost"
				aria-expanded={legendExpanded}
				aria-label={$_("canvasOverlay.legendToggleAria")}
				onclick={() => legendExpanded = !legendExpanded}
			>
				<span>{$_("canvasOverlay.legendColors")}</span>
				<span class="legend-arrow" class:rotated={legendExpanded}>▼</span>
			</button>

			{#if legendExpanded}
				<div class="legend-content ws-sans" aria-label={$_("canvasOverlay.legendContentAria")}>
					<div class="legend-group-title">{$_("canvasOverlay.legendGroupWork")}</div>
					{#each CANVAS_WORK_OVERLAY_KINDS as kind (kind)}
						{@const meta = CANVAS_WORK_OVERLAY_META[kind]}
						{#if meta.swatches}
							{#each meta.swatches as swatch (swatch.labelCode)}
								<div class="legend-item">
									<span class="legend-color-dot" style={`background: ${swatch.color};`}></span>
									<span class="legend-item-label">{kindShortLabel(kind)}: {$_(`canvasOverlay.swatch.${swatch.labelCode}`)}</span>
								</div>
							{/each}
						{/if}
					{/each}

					<div class="legend-group-title">{$_("canvasOverlay.legendGroupFrames")}</div>
					{#each CANVAS_CHROME_OVERLAY_SWATCHES as swatch (swatch.labelCode)}
						<div class="legend-item">
							{#if swatch.type === 'border'}
								<span class="legend-color-border" style={`color: ${swatch.color};`}></span>
							{:else if swatch.type === 'line'}
								<span class="legend-color-line" style={`background: ${swatch.color};`}></span>
							{/if}
							<span class="legend-item-label">{$_(`canvasOverlay.chromeSwatch.${swatch.labelCode}`)}</span>
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	</section>
{/if}

<style>
	.overlay-controls {
		position: absolute;
		top: 74px;
		right: 12px;
		display: grid;
		gap: 0;
		width: min(232px, calc(100% - 24px));
		padding: 6px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface) 88%, transparent);
		color: var(--color-ws-ink);
		box-shadow: 0 1px 0 color-mix(in srgb, var(--color-ws-ink) 3%, transparent) inset, 0 14px 40px -28px color-mix(in srgb, var(--color-ws-bg) 90%, transparent);
		backdrop-filter: blur(14px);
		-webkit-backdrop-filter: blur(14px);
	}

	.overlay-controls-head {
		display: none;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
	}

	.overlay-controls-head span {
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 850;
		letter-spacing: 0;
	}

	.overlay-controls-head strong {
		min-width: 24px;
		padding: 2px 6px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-surface2) 82%, transparent);
		color: var(--color-ws-ink);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		text-align: center;
	}

	.overlay-toggle-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 5px;
	}

	.overlay-toggle {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 4px;
		min-width: 0;
		min-height: 40px;
		padding: 6px 7px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 46%, transparent);
		color: var(--color-ws-text);
		cursor: pointer;
		font-family: inherit;
	}

	.overlay-toggle.active {
		border-color: color-mix(in srgb, var(--color-ws-green) 44%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 13%, transparent);
		color: var(--color-ws-ink);
	}

	.overlay-swatch {
		width: 8px;
		height: 8px;
		border-radius: 999px;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-ws-bg) 72%, transparent);
	}

	.overlay-swatch.qc {
		background: var(--color-ws-amber);
	}

	.overlay-swatch.comment {
		background: var(--color-ws-green);
	}

	.overlay-swatch.ai-review {
		background: var(--color-ws-rose);
	}

	.overlay-label {
		overflow: hidden;
		font-size: 10px;
		font-weight: 850;
		line-height: 1;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.overlay-toggle strong {
		color: inherit;
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}

	.overlay-controls.inactive {
		border-style: dashed;
	}

	.overlay-controls.compact {
		width: min(174px, calc(100% - 24px));
		padding: 4px;
		border-radius: var(--radius-ws-ctrl);
	}

	.overlay-controls.quiet {
		width: min(86px, calc(100% - 24px));
		background: color-mix(in srgb, var(--color-ws-surface) 68%, transparent);
		box-shadow: 0 10px 24px -18px color-mix(in srgb, var(--color-ws-bg) 88%, transparent);
	}

	.overlay-summary-button {
		display: grid;
		grid-template-columns: auto auto minmax(0, 1fr);
		gap: 6px;
		align-items: center;
		width: 100%;
		min-height: 40px;
		padding: 6px 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-green) 28%, transparent);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 52%, transparent);
		color: var(--color-ws-ink);
		cursor: pointer;
		font: inherit;
		text-align: left;
	}

	.overlay-controls.quiet .overlay-summary-button {
		grid-template-columns: auto auto;
		justify-content: center;
		padding-inline: 7px;
		border-color: var(--ws-hair-strong);
		background: color-mix(in srgb, var(--color-ws-surface2) 42%, transparent);
	}

	.overlay-summary-button span {
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 850;
	}

	.overlay-summary-button strong {
		min-width: 24px;
		padding: 2px 6px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-green) 16%, transparent);
		color: var(--color-ws-ink);
		font-size: 11px;
		text-align: center;
	}

	.overlay-summary-button small {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 750;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.overlay-collapse-button {
		margin-top: 5px;
		width: 100%;
		min-height: 40px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 42%, transparent);
		color: var(--color-ws-text);
		cursor: pointer;
		font: inherit;
		font-size: 10px;
		font-weight: 800;
	}

	.overlay-controls.suppressed {
		width: min(150px, calc(100% - 24px));
		padding: 4px;
		background: color-mix(in srgb, var(--color-ws-surface) 82%, transparent);
		box-shadow: 0 10px 24px -18px color-mix(in srgb, var(--color-ws-bg) 88%, transparent);
	}

	.overlay-controls.suppressed.quiet {
		width: min(78px, calc(100% - 24px));
		background: color-mix(in srgb, var(--color-ws-surface) 64%, transparent);
	}

	.overlay-suppressed-chip {
		display: grid;
		grid-template-columns: auto auto minmax(0, 1fr);
		gap: 5px;
		align-items: center;
		min-height: 36px;
		padding: 4px 6px;
		border: 1px dashed var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-text);
	}

	.overlay-controls.quiet .overlay-suppressed-chip {
		grid-template-columns: auto auto;
		justify-content: center;
		border-color: var(--ws-hair-strong);
	}

	.overlay-suppressed-chip span {
		font-size: 10px;
		font-weight: 850;
	}

	.overlay-suppressed-chip strong {
		min-width: 22px;
		padding: 2px 5px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-surface2) 82%, transparent);
		color: var(--color-ws-ink);
		font-size: 10px;
		text-align: center;
	}

	.overlay-suppressed-chip small {
		overflow: hidden;
		font-size: 10px;
		font-weight: 750;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.legend-toggle {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		margin-top: 6px;
		min-height: 36px;
		padding: 6px 8px;
		border: 1px dashed var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 28%, transparent);
		color: var(--color-ws-text);
		cursor: pointer;
		font-family: inherit;
		font-size: 10px;
		font-weight: 800;
		transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
	}

	.legend-toggle:hover {
		border-color: var(--ws-hair-strong);
		background: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
		color: var(--color-ws-ink);
	}

	.legend-toggle:active {
		background: color-mix(in srgb, var(--color-ws-surface2) 76%, transparent);
	}

	.legend-arrow {
		font-size: 8px;
		transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
		color: var(--color-ws-faint);
		display: inline-block;
	}

	.legend-arrow.rotated {
		transform: rotate(180deg);
	}

	.legend-content {
		margin-top: 6px;
		padding: 8px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: var(--color-ws-surface2);
		display: grid;
		gap: 6px;
		animation: legendFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
	}

	@keyframes legendFadeIn {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.legend-group-title {
		color: var(--color-ws-faint);
		font-size: 8px;
		font-weight: 850;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		border-bottom: 1px solid var(--ws-hair);
		padding-bottom: 2px;
		margin-top: 2px;
		text-align: left;
	}

	.legend-group-title:first-child {
		margin-top: 0;
	}

	.legend-item {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 18px;
	}

	.legend-color-dot {
		width: 7px;
		height: 7px;
		border-radius: 999px;
		flex-shrink: 0;
		box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--color-ws-bg) 78%, transparent);
	}

	.legend-color-border {
		width: 8px;
		height: 8px;
		border: 1.5px solid currentColor;
		border-radius: 2px;
		background: color-mix(in srgb, var(--color-ws-ink) 3%, transparent);
		flex-shrink: 0;
	}

	.legend-color-line {
		width: 10px;
		height: 2px;
		flex-shrink: 0;
		border-radius: 999px;
	}

	.legend-item-label {
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 600;
		line-height: 1.2;
		text-align: left;
	}

	@media (max-width: 980px) {
		.overlay-controls {
			top: 86px;
			width: min(232px, calc(100% - 18px));
		}
	}
</style>
