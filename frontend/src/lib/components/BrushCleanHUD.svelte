<script lang="ts">
	import { onMount } from "svelte";
	import { _ } from "$lib/i18n";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { getCanvasOverlayZIndex } from "$lib/editor/overlay-priority.js";

	let brushSize = $derived(editorStore.brushSize);
	let brushOpacity = $derived(editorStore.brushOpacity);
	let brushMode = $derived(editorStore.brushMode);
	let canRestore = $derived(editorStore.brushTarget.canRestore);
	let canBrush = $derived(editorStore.brushTarget.canBrush);
	// Producer emits stable codes; localize here. `titleCode === null` means
	// `title` is a dynamic display name (layer/text content) shown verbatim.
	let brushTargetTitle = $derived(
		editorStore.brushTarget.titleCode
			? $_(`brushTarget.title.${editorStore.brushTarget.titleCode}`)
			: editorStore.brushTarget.title || $_("brushTarget.titleFallback"),
	);
	let brushEraseLabel = $derived($_(`brushTarget.erase.${editorStore.brushTarget.eraseLabelCode}`));
	let brushRestoreLabel = $derived($_(`brushTarget.restore.${editorStore.brushTarget.restoreLabelCode}`));
	let brushModeLabel = $derived(brushMode === "erase" ? brushEraseLabel : brushRestoreLabel);

	let isCollapsed = $state(false);

	onMount(() => {
		if (window.innerWidth <= 1024) {
			isCollapsed = true;
		}
	});

	function handleSizeChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.setBrushSize(Number(target.value));
	}

	function handleOpacityChange(e: Event) {
		const target = e.target as HTMLInputElement;
		editorStore.setBrushOpacity(Number(target.value));
	}

	function toggleMode(mode: "erase" | "restore") {
		editorStore.setBrushMode(mode);
	}
</script>

<div
	class="brush-clean-hud ws-sans ws-panel"
	class:collapsed={isCollapsed}
	style={`z-index:${getCanvasOverlayZIndex("tool-hint")};`}
	role="region"
	aria-label={$_("brushTarget.hudRegionAria")}
>
	{#if isCollapsed}
		<div class="hud-collapsed-row">
			<div class="hud-collapsed-meta">
				<span class="hud-status-dot" class:active={canBrush}></span>
				<span class="hud-collapsed-text">
					{$_("brushTarget.brushPrefix")} <strong>{brushSize}px</strong> · <strong>{brushOpacity}%</strong> ·
					<strong>{brushModeLabel}</strong>
				</span>
			</div>
			<button
				type="button"
				class="hud-toggle-btn ws-btn-ghost"
				onclick={() => isCollapsed = false}
				aria-label={$_("brushTarget.expandAria")}
			>
				{$_("brushTarget.settings")}
			</button>
		</div>
	{:else}
		<div class="hud-header">
			<div class="hud-header-left">
				<span class="hud-status-dot" class:active={canBrush}></span>
				<div class="hud-title-wrap">
					<span class="hud-eyebrow">{$_("brushTarget.eyebrow")}</span>
					<strong class="hud-title">{brushTargetTitle}</strong>
				</div>
			</div>
			<button
				type="button"
				class="hud-toggle-btn secondary ws-btn-ghost"
				onclick={() => isCollapsed = true}
				aria-label={$_("brushTarget.collapseAria")}
			>
				{$_("brushTarget.collapse")}
			</button>
		</div>

		<div class="hud-controls">
			<!-- Size Slider -->
			<div class="hud-control-group">
				<div class="hud-control-label">
					<span>{$_("brushTarget.brushSize")}</span>
					<strong>{brushSize} px</strong>
				</div>
				<div class="slider-wrapper">
					<input
						type="range"
						min="5"
						max="100"
						step="1"
						value={brushSize}
						oninput={handleSizeChange}
						aria-label={$_("brushTarget.brushSizeAria")}
					/>
				</div>
			</div>

			<!-- Opacity Slider -->
			<div class="hud-control-group">
				<div class="hud-control-label">
					<span>{$_("brushTarget.opacity")}</span>
					<strong>{brushOpacity}%</strong>
				</div>
				<div class="slider-wrapper">
					<input
						type="range"
						min="0"
						max="100"
						step="1"
						value={brushOpacity}
						oninput={handleOpacityChange}
						aria-label={$_("brushTarget.opacityAria")}
					/>
				</div>
			</div>

			<!-- Mode Toggles -->
			<div class="hud-modes" aria-label={$_("brushTarget.modeLabel")}>
				<button
					type="button"
					class="hud-mode-btn ws-btn-ghost"
					class:active={brushMode === "erase"}
					onclick={() => toggleMode("erase")}
					aria-pressed={brushMode === "erase"}
				>
					<strong>{brushEraseLabel}</strong>
					<small>{$_("brushTarget.eraseHint")}</small>
				</button>

				{#if canRestore}
					<button
						type="button"
						class="hud-mode-btn ws-btn-ghost"
						class:active={brushMode === "restore"}
						onclick={() => toggleMode("restore")}
						aria-pressed={brushMode === "restore"}
						title={$_("brushTarget.restoreModeTitle")}
					>
						<strong>{brushRestoreLabel}</strong>
						<small>{$_("brushTarget.restoreHint")}</small>
					</button>
				{:else}
					<div
						class="passive-restore-receipt"
						title={$_("brushTarget.noBrushMarksTitle")}
					>
						<strong>{$_("brushTarget.noBrushMarks")}</strong>
						<small>{$_("brushTarget.readyToErase")}</small>
					</div>
				{/if}
			</div>
		</div>

		<div class="hud-footer">
			<span class="shortcut-pill"><kbd>[</kbd> <kbd>]</kbd> {$_("brushTarget.shortcutResize")}</span>
			<span class="shortcut-pill"><kbd>E</kbd> {$_("brushTarget.shortcutToggle")}</span>
		</div>
	{/if}
</div>

<style>
	.brush-clean-hud {
		position: absolute;
		bottom: 24px;
		left: 24px;
		display: flex;
		flex-direction: column;
		width: 280px;
		padding: 16px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface) 84%, transparent);
		backdrop-filter: blur(20px);
		-webkit-backdrop-filter: blur(20px);
		box-shadow: 0 1px 0 color-mix(in srgb, var(--color-ws-ink) 4%, transparent) inset, 0 14px 40px -28px color-mix(in srgb, var(--color-ws-bg) 90%, transparent);
		color: var(--color-ws-ink);
		font-family: var(--font-ws-sans);
		transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
		pointer-events: auto;
	}

	.brush-clean-hud.collapsed {
		width: 320px;
		padding: 10px 14px;
		border-radius: var(--radius-ws-ctrl);
	}

	.hud-collapsed-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
	}

	.hud-collapsed-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.hud-collapsed-text {
		font-size: 11px;
		color: var(--color-ws-text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.hud-collapsed-text strong {
		color: var(--color-ws-blue);
		font-weight: 800;
	}

	.hud-toggle-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 40px; /* touch safety target */
		padding: 0 12px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 48%, transparent);
		color: var(--color-ws-ink);
		font-size: 11px;
		font-weight: 800;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.hud-toggle-btn:hover {
		background: color-mix(in srgb, var(--color-ws-surface2) 72%, transparent);
		border-color: var(--ws-hair-strong);
	}

	.hud-toggle-btn.secondary {
		min-height: 40px; /* touch safety audit compliant */
		padding: 0 12px;
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 36%, transparent);
		border-color: var(--ws-hair);
		color: var(--color-ws-text);
	}

	.hud-toggle-btn.secondary:hover {
		background: color-mix(in srgb, var(--color-ws-surface2) 62%, transparent);
		color: var(--color-ws-ink);
	}

	.hud-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--ws-hair);
		margin-bottom: 12px;
	}

	.hud-header-left {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.hud-status-dot {
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--color-ws-faint);
		transition: background-color 0.3s ease;
		flex-shrink: 0;
	}

	.hud-status-dot.active {
		background: var(--color-ws-green);
		box-shadow: 0 0 8px color-mix(in srgb, var(--color-ws-green) 58%, transparent);
	}

	.hud-title-wrap {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.hud-eyebrow {
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--color-ws-faint);
		font-weight: 800;
	}

	.hud-title {
		font-size: 13px;
		font-weight: 800;
		color: var(--color-ws-ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.hud-controls {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.hud-control-group {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.hud-control-label {
		display: flex;
		justify-content: space-between;
		font-size: 11px;
		color: var(--color-ws-faint);
		font-weight: 700;
	}

	.hud-control-label strong {
		color: var(--color-ws-blue);
	}

	.slider-wrapper {
		display: flex;
		align-items: center;
		height: 40px; /* touch safety */
	}

	.slider-wrapper input[type="range"] {
		width: 100%;
		height: 40px; /* touch safety target: exactly 40px! */
		background: transparent;
		margin: 0;
		cursor: pointer;
		-webkit-appearance: none;
	}

	.slider-wrapper input[type="range"]::-webkit-slider-runnable-track {
		width: 100%;
		height: 4px;
		border-radius: 999px;
		background: var(--ws-hair-strong);
	}

	.slider-wrapper input[type="range"]::-moz-range-track {
		width: 100%;
		height: 4px;
		border-radius: 999px;
		background: var(--ws-hair-strong);
	}

	.slider-wrapper input[type="range"]::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 12px;
		height: 12px;
		border-radius: 999px;
		background: var(--color-ws-ink);
		box-shadow: 0 2px 4px color-mix(in srgb, var(--color-ws-bg) 70%, transparent);
		margin-top: -4px; /* centers the 12px thumb in the 4px track: (4px - 12px)/2 = -4px */
		transition: transform 0.1s ease;
	}

	.slider-wrapper input[type="range"]::-moz-range-thumb {
		width: 12px;
		height: 12px;
		border: 0;
		border-radius: 999px;
		background: var(--color-ws-ink);
		box-shadow: 0 2px 4px color-mix(in srgb, var(--color-ws-bg) 70%, transparent);
		transition: transform 0.1s ease;
	}

	.slider-wrapper input[type="range"]::-webkit-slider-thumb:hover {
		transform: scale(1.2);
	}

	.slider-wrapper input[type="range"]::-moz-range-thumb:hover {
		transform: scale(1.2);
	}

	.hud-modes {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 6px;
		margin-top: 4px;
	}

	.hud-mode-btn {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		min-height: 44px; /* touch safety */
		padding: 6px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 26%, transparent);
		color: var(--color-ws-text);
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.hud-mode-btn:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 8%, transparent);
		color: var(--color-ws-ink);
	}

	.hud-mode-btn.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 52%, transparent);
		background: linear-gradient(100deg, color-mix(in srgb, var(--color-ws-violet) 78%, var(--color-ws-surface2)), color-mix(in srgb, var(--color-ws-accent) 78%, var(--color-ws-surface2)));
		color: var(--color-ws-ink);
		box-shadow: 0 8px 18px -12px color-mix(in srgb, var(--color-ws-accent) 64%, transparent);
	}

	.hud-mode-btn strong {
		font-size: 10px;
		font-weight: 850;
	}

	.hud-mode-btn small {
		font-size: 8px;
		opacity: 0.8;
	}

	.passive-restore-receipt {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 44px;
		padding: 6px;
		border: 1px dashed var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 18%, transparent);
		color: var(--color-ws-faint);
		text-align: center;
	}

	.passive-restore-receipt strong {
		font-size: 9px;
		font-weight: 800;
	}

	.passive-restore-receipt small {
		font-size: 8px;
		opacity: 0.6;
	}

	.hud-footer {
		display: flex;
		justify-content: space-between;
		margin-top: 14px;
		padding-top: 10px;
		border-top: 1px solid var(--ws-hair);
		font-size: 9px;
		color: var(--color-ws-faint);
		font-weight: 700;
	}

	.shortcut-pill {
		display: inline-flex;
		align-items: center;
		gap: 3px;
	}

	kbd {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 14px;
		height: 14px;
		padding: 0 3px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: 4px;
		background: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
		color: var(--color-ws-text);
		font-size: 8px;
		font-family: monospace;
	}
</style>
