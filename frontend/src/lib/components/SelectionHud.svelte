<script lang="ts">
	/**
	 * SelectionHud — W3.3 floating contextual HUD for the selected object.
	 *
	 * A compact, ws-token-styled inspector that floats over the canvas and
	 * follows the current selection (text box / image / credit / AI result).
	 * Read-only summary: it surfaces the selected object's kind, name, position
	 * and size/opacity so the user can keep context without opening the full
	 * right-panel inspector. Collapsible + responsive. Purely additive: it
	 * renders nothing when there is no selection and never owns canvas events
	 * beyond its own toggle button.
	 */
	import { onMount } from "svelte";
	import { editorStore } from "$lib/stores/editor.svelte.ts";
	import { _ } from "$lib/i18n";
	import { isAiResultImageLayer } from "$lib/types.js";
	import { getCanvasOverlayZIndex } from "$lib/editor/overlay-priority.js";
	import {
		getCanvasWorkspaceSize,
		imageRegionToWorkspaceBox,
	} from "$lib/editor/overlay-geometry.js";

	const COMPACT_BREAKPOINT = 1024;
	const HUD_WIDTH = 248;
	const HUD_COMPACT_WIDTH = 280;
	// Estimated HUD heights (expanded vs collapsed) used only for clamping the
	// anchor within the workspace; the real element auto-sizes via CSS.
	const HUD_HEIGHT_EXPANDED = 160;
	const HUD_HEIGHT_COMPACT = 52;
	const ANCHOR_GAP = 12;
	const EDGE_PADDING = 12;

	let selectedTextLayer = $derived(editorStore.selectedLayer);
	let selectedImageLayer = $derived(editorStore.selectedImageLayer);
	let selectedImageIsAiResult = $derived(isAiResultImageLayer(selectedImageLayer));

	let kindLabel = $derived(
		selectedTextLayer
			? selectedTextLayer.sourceCategory === "credit"
				? $_("selectionHud.kindCreditText")
				: $_("selectionHud.kindTextBox")
			: selectedImageLayer
				? selectedImageIsAiResult
					? $_("selectionHud.kindAiResult")
					: selectedImageLayer.role === "credit"
						? $_("selectionHud.kindCreditImage")
						: $_("selectionHud.kindExtraImage")
				: "",
	);

	let title = $derived(
		selectedTextLayer
			? selectedTextLayer.name?.trim() || selectedTextLayer.text?.trim() || $_("selectionHud.kindTextBox")
			: selectedImageLayer
				? selectedImageLayer.name?.trim()
					|| selectedImageLayer.originalName
					|| selectedImageLayer.imageName
					|| $_("selectionHud.titleImageLayerFallback")
				: "",
	);

	let positionLabel = $derived(
		selectedTextLayer
			? `${Math.round(selectedTextLayer.x)}, ${Math.round(selectedTextLayer.y)}`
			: selectedImageLayer
				? `${Math.round(selectedImageLayer.x)}, ${Math.round(selectedImageLayer.y)}`
				: "",
	);

	let metricLabel = $derived(
		selectedTextLayer
			? `${selectedTextLayer.fontSize}px / ${selectedTextLayer.alignment ?? "center"}`
			: selectedImageLayer
				? `${Math.round(selectedImageLayer.w)} x ${Math.round(selectedImageLayer.h)} / ${Math.round((selectedImageLayer.opacity ?? 1) * 100)}%`
				: "",
	);

	let isLocked = $derived(
		(selectedTextLayer?.locked === true) || (selectedImageLayer?.locked === true),
	);
	let isHidden = $derived(
		selectedTextLayer
			? selectedTextLayer.visible === false
			: selectedImageLayer
				? selectedImageLayer.visible === false
				: false,
	);

	// Track the current workspace width so compact mode follows the live layout
	// (resize / rotate / split panes), not just a one-shot mount check.
	let workspaceWidth = $state(typeof window !== "undefined" ? window.innerWidth : 1280);
	// Manual collapse override; cleared whenever the layout crosses the
	// breakpoint so the auto behaviour can take back over.
	let manualCollapsed = $state<boolean | null>(null);

	let autoCompact = $derived(workspaceWidth <= COMPACT_BREAKPOINT);
	let isCollapsed = $derived(manualCollapsed ?? autoCompact);

	function setCollapsed(next: boolean) {
		manualCollapsed = next;
	}

	function measureWorkspaceWidth(): number {
		const size = getCanvasWorkspaceSize(editorStore.editor);
		if (size && size.width > 0) return size.width;
		return typeof window !== "undefined" ? window.innerWidth : 1280;
	}

	function syncWorkspaceWidth() {
		const next = measureWorkspaceWidth();
		const wasCompact = workspaceWidth <= COMPACT_BREAKPOINT;
		const nowCompact = next <= COMPACT_BREAKPOINT;
		workspaceWidth = next;
		// Crossing the breakpoint hands control back to the auto behaviour so a
		// stale manual override does not leave the HUD stuck.
		if (wasCompact !== nowCompact) manualCollapsed = null;
	}

	// Recompute on viewport/zoom/pan changes too (workspace can change size when
	// inspectors open/close, which also bumps viewportVersion).
	$effect(() => {
		editorStore.viewportVersion;
		syncWorkspaceWidth();
	});

	onMount(() => {
		syncWorkspaceWidth();
		if (typeof window === "undefined") return;
		const onResize = () => syncWorkspaceWidth();
		window.addEventListener("resize", onResize);
		const mql = typeof window.matchMedia === "function"
			? window.matchMedia(`(max-width: ${COMPACT_BREAKPOINT}px)`)
			: null;
		mql?.addEventListener?.("change", onResize);
		return () => {
			window.removeEventListener("resize", onResize);
			mql?.removeEventListener?.("change", onResize);
		};
	});

	// Derive the anchor from the selected layer's bounds projected through the
	// current viewport so the HUD contextualises the selection instead of always
	// covering the top-left corner. Falls back to the fixed corner when the
	// projection is unavailable (e.g. before the canvas is laid out).
	let anchorStyle = $derived.by(() => {
		editorStore.viewportVersion;
		const layer = selectedTextLayer ?? selectedImageLayer;
		if (!layer) return null;
		const box = imageRegionToWorkspaceBox(editorStore.editor, {
			x: layer.x,
			y: layer.y,
			w: layer.w,
			h: layer.h,
		});
		const size = getCanvasWorkspaceSize(editorStore.editor);
		if (!box || !size || size.width <= 0 || size.height <= 0) return null;

		const hudWidth = isCollapsed ? HUD_COMPACT_WIDTH : HUD_WIDTH;
		const hudHeight = isCollapsed ? HUD_HEIGHT_COMPACT : HUD_HEIGHT_EXPANDED;

		// Prefer above the selection; fall back below if there is no room above.
		let top = box.top - hudHeight - ANCHOR_GAP;
		if (top < EDGE_PADDING) {
			const below = box.top + box.height + ANCHOR_GAP;
			top = below + hudHeight + EDGE_PADDING <= size.height ? below : box.top + ANCHOR_GAP;
		}
		let left = box.left;

		const maxLeft = Math.max(EDGE_PADDING, size.width - hudWidth - EDGE_PADDING);
		const maxTop = Math.max(EDGE_PADDING, size.height - hudHeight - EDGE_PADDING);
		left = Math.min(Math.max(left, EDGE_PADDING), maxLeft);
		top = Math.min(Math.max(top, EDGE_PADDING), maxTop);

		return `left:${Math.round(left)}px;top:${Math.round(top)}px;`;
	});
</script>

{#if selectedTextLayer || selectedImageLayer}
	<div
		class="selection-hud ws-sans ws-panel"
		class:collapsed={isCollapsed}
		class:anchored={anchorStyle !== null}
		style={`z-index:${getCanvasOverlayZIndex("tool-hint")};${anchorStyle ?? ""}`}
		role="region"
		aria-label={$_("selectionHud.regionLabel")}
	>
		{#if isCollapsed}
			<div class="hud-collapsed-row">
				<div class="hud-collapsed-meta">
					<span class="hud-dot"></span>
					<span class="hud-collapsed-text">
						{kindLabel}: <strong>{title}</strong>
					</span>
				</div>
				<button
					type="button"
					class="hud-toggle-btn ws-btn-ghost"
					onclick={() => setCollapsed(false)}
					aria-label={$_("selectionHud.expandLabel")}
				>
					{$_("selectionHud.details")}
				</button>
			</div>
		{:else}
			<div class="hud-header">
				<div class="hud-header-left">
					<span class="hud-dot"></span>
					<div class="hud-title-wrap">
						<span class="hud-eyebrow">{kindLabel}</span>
						<strong class="hud-title">{title}</strong>
					</div>
				</div>
				<button
					type="button"
					class="hud-toggle-btn secondary ws-btn-ghost"
					onclick={() => setCollapsed(true)}
					aria-label={$_("selectionHud.collapseLabel")}
				>
					{$_("selectionHud.collapse")}
				</button>
			</div>

			<dl class="hud-stats">
				<div class="hud-stat">
					<dt>{$_("selectionHud.position")}</dt>
					<dd>{positionLabel}</dd>
				</div>
				<div class="hud-stat">
					<dt>{selectedTextLayer ? $_("selectionHud.fontAlign") : $_("selectionHud.sizeOpacity")}</dt>
					<dd>{metricLabel}</dd>
				</div>
			</dl>

			{#if isLocked || isHidden}
				<div class="hud-flags" aria-label={$_("selectionHud.statusLabel")}>
					{#if isLocked}<span class="hud-flag">{$_("selectionHud.locked")}</span>{/if}
					{#if isHidden}<span class="hud-flag">{$_("selectionHud.hidden")}</span>{/if}
				</div>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.selection-hud {
		position: absolute;
		top: 18px;
		left: 18px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		width: 248px;
		padding: 12px 14px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface) 86%, transparent);
		backdrop-filter: blur(18px);
		-webkit-backdrop-filter: blur(18px);
		box-shadow: 0 1px 0 color-mix(in srgb, var(--color-ws-ink) 4%, transparent) inset, 0 14px 40px -28px color-mix(in srgb, var(--color-ws-bg) 90%, transparent);
		color: var(--color-ws-ink);
		font-family: var(--font-ws-sans);
		/* The shell must not consume canvas pointer events: only the interactive
		   controls below re-enable pointer-events so clicks/drags on canvas
		   content underneath the HUD still reach Fabric. */
		pointer-events: none;
		transition: border-color 0.14s ease, background 0.14s ease;
	}

	/* Interactive controls opt back in to pointer events. */
	.selection-hud .hud-toggle-btn {
		pointer-events: auto;
	}

	.selection-hud.collapsed {
		width: 280px;
		padding: 9px 12px;
		border-radius: var(--radius-ws-ctrl);
	}

	.hud-collapsed-row,
	.hud-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
	}

	.hud-collapsed-meta,
	.hud-header-left {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.hud-dot {
		width: 6px;
		height: 6px;
		border-radius: 999px;
		flex: none;
		background: linear-gradient(100deg, var(--color-ws-violet), var(--color-ws-accent));
	}

	.hud-collapsed-text {
		font-size: 11px;
		color: var(--color-ws-text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	.hud-collapsed-text strong {
		color: var(--color-ws-ink);
		font-weight: 800;
	}

	.hud-title-wrap {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.hud-eyebrow {
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--color-ws-faint);
	}

	.hud-title {
		font-size: 13px;
		font-weight: 800;
		color: var(--color-ws-ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	.hud-toggle-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 36px;
		padding: 0 10px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 42%, transparent);
		color: var(--color-ws-ink);
		font-family: inherit;
		font-size: 11px;
		font-weight: 800;
		cursor: pointer;
		flex: none;
		transition: background 0.14s ease, border-color 0.14s ease;
	}

	.hud-toggle-btn:hover {
		background: color-mix(in srgb, var(--color-ws-surface2) 68%, transparent);
		border-color: var(--ws-hair-strong);
	}

	.hud-stats {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
		margin: 0;
	}

	.hud-stat {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		padding: 7px 8px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 28%, transparent);
	}

	.hud-stat dt {
		font-size: 9px;
		font-weight: 800;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		color: var(--color-ws-faint);
	}

	.hud-stat dd {
		margin: 0;
		font-size: 12px;
		font-weight: 700;
		color: var(--color-ws-ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.hud-flags {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.hud-flag {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 32%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-amber) 10%, transparent);
		color: var(--color-ws-amber);
		font-size: 10px;
		font-weight: 800;
	}

	@media (max-width: 900px) and (orientation: portrait) {
		.selection-hud {
			top: 12px;
			left: 12px;
			width: min(248px, calc(100vw - 24px));
		}
		.selection-hud.collapsed {
			width: min(280px, calc(100vw - 24px));
		}
	}
</style>
