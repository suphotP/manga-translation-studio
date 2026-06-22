<script lang="ts">
	type MetricTone = "cyan" | "violet" | "amber" | "blue" | "rose" | "teal" | "green" | "deadline" | "neutral";
	type MetricVariant = "dashboard" | "story" | "hero" | "compact";
	type MetricColumns = "auto" | "four" | "five";

	export interface MetricItem {
		id: string;
		label: string;
		value: string | number;
		detail?: string;
		icon?: string;
		tone?: MetricTone | string;
		ariaLabel?: string;
		onSelect?: () => void;
	}

	let {
		ariaLabel,
		metrics,
		variant = "story",
		columns = "auto",
	}: {
		ariaLabel: string;
		metrics: MetricItem[];
		variant?: MetricVariant;
		columns?: MetricColumns;
	} = $props();

	function metricClass(metric: MetricItem): string {
		return `workspace-metric-tile tone-${metric.tone ?? "neutral"}`;
	}
</script>

<div class={`workspace-metric-grid ${variant} columns-${columns}`} aria-label={ariaLabel}>
	{#each metrics as metric (metric.id)}
		{#if metric.onSelect}
			<button type="button" class={metricClass(metric)} aria-label={metric.ariaLabel ?? metric.label} onclick={metric.onSelect}>
				{#if metric.icon}
					<span class="metric-icon" aria-hidden="true">{metric.icon}</span>
				{/if}
				<span class="metric-copy">{metric.label}</span>
				<strong>{metric.value}</strong>
				{#if metric.detail}
					<em>{metric.detail}</em>
				{/if}
			</button>
		{:else}
			<article class={metricClass(metric)} role="group" aria-label={metric.ariaLabel ?? metric.label}>
				{#if metric.icon}
					<span class="metric-icon" aria-hidden="true">{metric.icon}</span>
				{/if}
				<span class="metric-copy">{metric.label}</span>
				<strong>{metric.value}</strong>
				{#if metric.detail}
					<em>{metric.detail}</em>
				{/if}
			</article>
		{/if}
	{/each}
</div>

<style>
	/* ws-token reskin · fluid responsive grid (auto-fit/minmax + container queries). */
	.workspace-metric-grid {
		container-type: inline-size;
		display: grid;
		min-width: 0;
		gap: 4px;
	}

	.workspace-metric-grid.columns-auto,
	.workspace-metric-grid.columns-four,
	.workspace-metric-grid.columns-five {
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 132px), 1fr));
	}

	.workspace-metric-grid.dashboard {
		gap: clamp(10px, 1.4vw, 16px);
	}

	.workspace-metric-grid.hero {
		gap: 1px;
		overflow: hidden;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-card, 12px);
		background: rgba(255, 255, 255, 0.02);
	}

	.workspace-metric-grid.compact {
		gap: 8px;
	}

	.workspace-metric-tile {
		display: grid;
		grid-area: auto;
		grid-column: auto;
		grid-row: auto;
		align-self: stretch;
		justify-self: stretch;
		width: 100%;
		min-width: 0;
		opacity: 1;
		rotate: 0deg;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		background: var(--color-ws-surface, #15151D);
		color: var(--color-ws-ink, #ececf2);
		font-family: inherit;
		text-align: left;
	}

	button.workspace-metric-tile {
		cursor: pointer;
		transition: background 0.14s ease, border-color 0.14s ease;
	}

	button.workspace-metric-tile:hover {
		border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 30%, transparent);
		background: var(--color-ws-surface2, #1C1C26);
	}

	.workspace-metric-grid.dashboard .workspace-metric-tile {
		min-height: 86px;
		grid-template-columns: 48px minmax(0, 1fr) auto;
		grid-template-rows: auto auto;
		align-items: center;
		gap: 2px 14px;
		padding: 14px;
		border-radius: var(--radius-ws, 16px);
		background: var(--color-ws-surface, #15151D);
		box-shadow: 0 1px 0 rgba(255, 255, 255, 0.02) inset, 0 14px 40px -28px rgba(0, 0, 0, 0.9);
	}

	.workspace-metric-grid.story .workspace-metric-tile,
	.workspace-metric-grid.compact .workspace-metric-tile {
		gap: 6px;
		min-height: 74px;
		padding: 13px 14px;
		border-radius: var(--radius-ws-card, 12px);
		color: var(--color-ws-text, #9a9aa8);
	}

	.workspace-metric-grid.hero .workspace-metric-tile {
		align-content: center;
		gap: 4px;
		min-height: 72px;
		padding: 12px 16px;
		border: 0;
		border-radius: 0;
		background: rgba(255, 255, 255, 0.025);
	}

	.metric-icon {
		display: grid;
		place-items: center;
		width: 48px;
		height: 48px;
		border-radius: 14px;
		background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-accent, #7c5cff) 24%, transparent);
		color: var(--color-ws-accent, #7c5cff);
		font-size: 20px;
		font-weight: 800;
	}

	.workspace-metric-grid:not(.dashboard) .metric-icon {
		width: 28px;
		height: 28px;
		border-radius: 9px;
		font-size: 14px;
	}

	.workspace-metric-grid.dashboard .metric-icon {
		grid-row: 1 / 3;
	}

	.metric-copy {
		color: var(--color-ws-faint, #6b6b78);
		font-size: 10px;
		font-weight: 700;
		line-height: 1.2;
	}

	.workspace-metric-grid.dashboard .metric-copy {
		align-self: end;
		font-size: 11px;
		font-weight: 700;
	}

	.workspace-metric-tile strong {
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--color-ws-ink, #ececf2);
		font-size: 23px;
		font-weight: 800;
		line-height: 1;
		font-variant-numeric: tabular-nums;
	}

	.workspace-metric-grid.dashboard .workspace-metric-tile strong {
		grid-column: 2;
		align-self: start;
		font-size: clamp(22px, 2.4vw, 28px);
		font-weight: 800;
	}

	.workspace-metric-grid.hero .workspace-metric-tile strong {
		font-size: 24px;
	}

	.workspace-metric-tile em {
		color: var(--color-ws-faint, #6b6b78);
		font-size: 10px;
		font-style: normal;
		font-weight: 700;
		line-height: 1.25;
	}

	.workspace-metric-grid.dashboard .workspace-metric-tile em {
		grid-column: 3;
		grid-row: 2;
		color: color-mix(in srgb, var(--color-ws-green, #34d399) 80%, transparent);
		font-weight: 700;
	}

	.workspace-metric-tile.tone-cyan .metric-icon { background: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-accent, #7c5cff) 24%, transparent); color: var(--color-ws-accent, #7c5cff); }
	.workspace-metric-tile.tone-violet .metric-icon { background: color-mix(in srgb, var(--color-ws-violet, #8B5CF6) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-violet, #8B5CF6) 22%, transparent); color: #c4b5fd; }
	.workspace-metric-tile.tone-amber .metric-icon { background: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 10%, transparent); border-color: color-mix(in srgb, var(--color-ws-amber, #FBBF24) 20%, transparent); color: var(--color-ws-amber, #FBBF24); }
	.workspace-metric-tile.tone-blue .metric-icon { background: color-mix(in srgb, var(--color-ws-blue, #8fb8ff) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-blue, #8fb8ff) 22%, transparent); color: var(--color-ws-blue, #8fb8ff); }
	.workspace-metric-tile.tone-rose .metric-icon { background: color-mix(in srgb, var(--color-ws-rose, #FB7185) 10%, transparent); border-color: color-mix(in srgb, var(--color-ws-rose, #FB7185) 20%, transparent); color: var(--color-ws-rose, #FB7185); }
	.workspace-metric-tile.tone-green .metric-icon { background: color-mix(in srgb, var(--color-ws-green, #34d399) 10%, transparent); border-color: color-mix(in srgb, var(--color-ws-green, #34d399) 20%, transparent); color: var(--color-ws-green, #34d399); }

	.workspace-metric-tile.tone-deadline strong {
		color: var(--color-ws-rose, #fb7185);
	}

	.workspace-metric-grid.hero .workspace-metric-tile.tone-deadline strong {
		font-size: 16px;
	}

	/* Deadline value is a date string, not a single number — keep it from wrapping into a
	   ragged 3-line block next to the single-digit tiles. */
	.workspace-metric-grid.story .workspace-metric-tile.tone-deadline strong,
	.workspace-metric-grid.compact .workspace-metric-tile.tone-deadline strong {
		font-size: 15px;
		line-height: 1.2;
	}

	/* Narrow containers keep a compact 2-up tile grid instead of collapsing to a
	   single full-width tower (which made the story/chapter KPI rows scroll forever). */
	@container (max-width: 420px) {
		.workspace-metric-grid.columns-auto,
		.workspace-metric-grid.columns-four,
		.workspace-metric-grid.columns-five {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	/* Only fall back to a single column when there genuinely isn't room for two. */
	@container (max-width: 240px) {
		.workspace-metric-grid.columns-auto,
		.workspace-metric-grid.columns-four,
		.workspace-metric-grid.columns-five {
			grid-template-columns: 1fr;
		}
	}
</style>
