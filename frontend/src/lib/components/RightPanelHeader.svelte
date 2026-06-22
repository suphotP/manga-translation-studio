<script lang="ts">
	import { _ } from "$lib/i18n";
	import type { RightPanelContext, RightPanelTab, RightPanelTextSlot } from "$lib/panels/right-panel-model.js";
	import type { RightPanelMode } from "$lib/stores/editor-ui.svelte.ts";

	interface Props {
		pageLabel: string;
		tabs: readonly RightPanelTab[];
		activeMode: RightPanelMode;
		context: RightPanelContext;
		getTabMeta: (id: RightPanelMode) => string;
		onModeChange: (id: RightPanelMode) => void;
	}

	let { pageLabel, tabs, activeMode, context, getTabMeta, onModeChange }: Props = $props();

	// Resolve a producer text slot: either an already-localized literal `value` or
	// an i18n `key` (+ optional interpolation `values`). The right-panel model now
	// emits these slots instead of rendered Thai, so the whole header localizes.
	function slot(s: RightPanelTextSlot | undefined): string {
		if (!s) return "";
		if (s.value !== undefined) return s.value;
		if (s.key) return $_(s.key, s.values ? { values: s.values } : undefined);
		return "";
	}
	function tabLabel(tab: RightPanelTab): string {
		return $_(tab.labelKey);
	}
	function tabDescription(tab: RightPanelTab): string {
		return $_(tab.descriptionKey);
	}

	let activeTab = $derived(tabs.find((tab) => tab.id === activeMode) ?? tabs[0] ?? null);
	let isLayersMode = $derived(activeMode === "layers");
	let contextTitle = $derived(slot(context.title));
	let contextEyebrow = $derived(slot(context.eyebrow));
	let contextDetail = $derived(slot(context.detail));
	let contextBadge = $derived(slot(context.badge));
	let contextPanelLabel = $derived(context.panelLabel ? slot(context.panelLabel) : null);
	let activePanelLabel = $derived(contextPanelLabel ?? (activeTab ? tabLabel(activeTab) : null));
	let activeMeta = $derived(activeTab ? getTabMeta(activeTab.id) : "");
	let titleMeta = $derived(
		isLayersMode
			? `${contextTitle}${contextBadge ? ` / ${contextBadge}` : ""}`
			: activePanelLabel && activeMeta.trim().toLowerCase() === activePanelLabel.trim().toLowerCase()
				? pageLabel
				: (activeMeta || pageLabel),
	);
	let titleDescription = $derived(
		isLayersMode
			? `${pageLabel} / ${contextEyebrow}: ${contextTitle}. ${contextDetail}`
			: activeTab
				? `${pageLabel} / ${tabDescription(activeTab)}`
				: pageLabel,
	);
</script>

<div class="right-panel-top" class:layers-compact={isLayersMode}>
	<div class="right-panel-title">
		<span>{activePanelLabel ? $_("rightPanel.header.panelNamed", { values: { name: activePanelLabel } }) : $_("rightPanel.header.panelGeneric")}</span>
		<small title={titleDescription}>
			{titleMeta}
		</small>
	</div>
	<div class="right-panel-mode-picker" role="tablist" aria-label={$_("rightPanel.header.pickerAria")}>
		{#each tabs as tab (tab.id)}
			{@const tabMeta = getTabMeta(tab.id)}
			{@const label = tabLabel(tab)}
			{@const description = tabDescription(tab)}
			<button
				type="button"
				role="tab"
				class="ws-seg"
				class:active={activeMode === tab.id}
				aria-selected={activeMode === tab.id}
				aria-label={tabMeta ? $_("rightPanel.header.openTabAriaMeta", { values: { label, description, meta: tabMeta } }) : $_("rightPanel.header.openTabAria", { values: { label, description } })}
				title={tabMeta ? $_("rightPanel.header.tabTitleMeta", { values: { label, description, meta: tabMeta } }) : $_("rightPanel.header.tabTitle", { values: { label, description } })}
				onclick={() => onModeChange(tab.id)}
			>
				<strong>{label}</strong>
				{#if tabMeta}
					<small>{tabMeta}</small>
				{/if}
			</button>
		{/each}
	</div>
	{#if !isLayersMode}
		<div class={`right-panel-context ${context.tone}`} aria-live="polite">
			<div class="right-panel-context-main">
				<span>{contextEyebrow}</span>
				<strong>{contextTitle}</strong>
				<small>{contextDetail}</small>
			</div>
			<span class="right-panel-context-badge">{contextBadge}</span>
		</div>
	{/if}
</div>

<style>
	.right-panel-top {
		flex: 0 0 auto;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 8px;
		align-items: center;
		padding: 8px 10px;
		border-bottom: 1px solid var(--ws-hair);
		background: var(--color-ws-bg);
		font-family: var(--font-ws-sans);
	}

	.right-panel-title {
		display: flex;
		min-width: 0;
		flex-direction: column;
		align-items: baseline;
		gap: 2px;
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 780;
	}

	.right-panel-title small {
		min-width: 0;
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 500;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* A real segmented control (tablist): a single inset track holds four equal
	   tabs, and the active tab reads as a raised "pill" inside it — so the current
	   section is obvious at a glance and every section is one tap away (no cycler). */
	.right-panel-mode-picker {
		grid-column: 1 / -1;
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 3px;
		padding: 3px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface2) 66%, transparent);
	}

	.right-panel-mode-picker button {
		display: flex;
		min-width: 0;
		min-height: 40px;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1px;
		padding: 4px 5px;
		border: 1px solid transparent;
		border-radius: var(--radius-ws-ctrl);
		background: transparent;
		color: var(--color-ws-text);
		cursor: pointer;
		font-family: var(--font-ws-sans);
		letter-spacing: 0;
		line-height: 1.05;
		transition: color 0.14s ease, background 0.14s ease, border-color 0.14s ease;
	}

	.right-panel-mode-picker button:hover:not(.active) {
		background: color-mix(in srgb, var(--color-ws-surface2) 82%, transparent);
		color: var(--color-ws-ink);
	}

	.right-panel-mode-picker button.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 50%, transparent);
		background: linear-gradient(100deg,
			color-mix(in srgb, var(--color-ws-violet) 24%, transparent),
			color-mix(in srgb, var(--color-ws-accent) 14%, transparent));
		color: var(--color-ws-ink);
		box-shadow: 0 1px 0 color-mix(in srgb, var(--color-ws-bg) 70%, transparent);
	}

	.right-panel-mode-picker button.active strong {
		color: color-mix(in srgb, var(--color-ws-violet) 72%, var(--color-ws-ink));
	}

	.right-panel-mode-picker strong,
	.right-panel-mode-picker small {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.right-panel-mode-picker strong {
		font-size: 10px;
		font-weight: 850;
	}

	.right-panel-mode-picker small {
		color: var(--color-ws-text);
		font-size: 9px;
		font-weight: 800;
	}

	.right-panel-context {
		grid-column: 1 / -1;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 6px;
		min-height: 38px;
		padding: 6px 8px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 48%, transparent);
	}

	.right-panel-context.attention {
		border-color: color-mix(in srgb, var(--color-ws-amber) 38%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 8%, transparent);
	}

	.right-panel-context.ready {
		border-color: color-mix(in srgb, var(--color-ws-green) 32%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 7%, transparent);
	}

	.right-panel-context.running {
		border-color: color-mix(in srgb, var(--color-ws-accent) 42%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 12%, transparent);
	}

	.right-panel-context-main {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.right-panel-context-main span,
	.right-panel-context-main small,
	.right-panel-context-main strong {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.right-panel-context-main span {
		display: none;
	}

	.right-panel-context-main strong {
		color: var(--color-ws-ink);
		font-size: 12px;
		line-height: 1.2;
		white-space: nowrap;
	}

	.right-panel-context-main small {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 10px;
		line-height: 1.2;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.right-panel-context-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		max-width: 78px;
		min-height: 22px;
		padding: 0 7px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-ws-surface2) 72%, transparent);
		color: var(--color-ws-ink);
		font-size: 10px;
		font-weight: 850;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@media (max-width: 900px) and (orientation: portrait) {
		.right-panel-top {
			padding: 7px 10px;
		}

		.right-panel-title {
			margin-bottom: 6px;
		}

		.right-panel-context {
			min-height: 44px;
			margin-top: 6px;
			padding: 7px 8px;
			border-radius: var(--radius-ws-ctrl);
		}

		.right-panel-context-main {
			gap: 1px;
		}

		.right-panel-context-main strong {
			font-size: 11px;
		}

		.right-panel-context-main small {
			display: none;
		}
	}

	@media (min-width: 901px) and (max-width: 1180px) and (pointer: coarse) {
		.right-panel-top {
			gap: 4px;
			padding: 6px 7px;
		}

		.right-panel-top.layers-compact {
			padding-bottom: 6px;
		}

		.right-panel-mode-picker {
			gap: 3px;
		}

		.right-panel-mode-picker button {
			min-height: 40px;
			padding: 4px 3px;
		}

		.right-panel-mode-picker small {
			display: none;
		}

		.right-panel-context {
			min-height: 36px;
			padding: 6px 7px;
		}

		.right-panel-context-badge {
			max-width: 64px;
		}
	}
</style>
