<script lang="ts">
	type PipelineVariant = "story" | "chapter";

	export interface PipelineCard {
		id: string;
		label: string;
		title: string;
		detail?: string;
		accent: string;
		progress: number;
		avatars?: string[];
		ariaLabel?: string;
	}

	let {
		ariaLabel,
		eyebrow,
		title,
		actionLabel,
		onAction,
		cards,
		variant = "story",
	}: {
		ariaLabel: string;
		eyebrow: string;
		title: string;
		actionLabel?: string;
		onAction?: () => void;
		cards: PipelineCard[];
		variant?: PipelineVariant;
	} = $props();

	function clampedProgress(value: number): number {
		return Math.min(100, Math.max(0, value));
	}
</script>

<section class={`workspace-pipeline-panel ${variant}`} aria-label={ariaLabel}>
	<header>
		<div>
			<span>{eyebrow}</span>
			<strong>{title}</strong>
		</div>
		{#if actionLabel && onAction}
			<button type="button" onclick={onAction}>{actionLabel}</button>
		{/if}
	</header>
	<div class="workspace-pipeline-grid">
		{#each cards as card (card.id)}
			<article class={`workspace-pipeline-card ${card.accent}`} role="group" aria-label={card.ariaLabel ?? card.label}>
				<div class="pipeline-copy">
					<span>{card.label}</span>
					<strong>{card.title}</strong>
					{#if card.detail}
						<small>{card.detail}</small>
					{/if}
				</div>
				{#if card.avatars?.length}
					<div class="pipeline-avatar-stack" aria-hidden="true">
						{#each card.avatars as avatar, index (`${card.id}-${index}`)}
							<i>{avatar}</i>
						{/each}
					</div>
				{/if}
				<div class="pipeline-meter"><i style={`width: ${clampedProgress(card.progress)}%`}></i></div>
			</article>
		{/each}
	</div>
</section>

<style>
	/* ws-token reskin · fluid responsive grid (auto-fit/minmax, clamp spacing). */
	.workspace-pipeline-panel {
		container-type: inline-size;
		display: grid;
		min-width: 0;
		gap: clamp(10px, 1.4vw, 14px);
		padding: clamp(12px, 1.6vw, 16px);
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws, 16px);
		background: #15151d;
		box-shadow: 0 1px 0 rgba(255, 255, 255, 0.02) inset, 0 14px 40px -28px rgba(0, 0, 0, 0.9);
	}

	.workspace-pipeline-panel > header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 10px 12px;
	}

	.workspace-pipeline-panel header span {
		display: block;
		color: #c4b5fd;
		font-size: 10px;
		font-weight: 900;
		letter-spacing: 0.13em;
		text-transform: uppercase;
	}

	.workspace-pipeline-panel header strong {
		display: block;
		margin-top: 3px;
		color: var(--color-ws-ink, #ececf2);
		font-size: 14px;
		font-weight: 800;
		line-height: 1.2;
	}

	.workspace-pipeline-panel.story header strong {
		font-size: 15px;
	}

	.workspace-pipeline-panel button {
		min-height: 40px;
		padding: 0 12px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: rgba(255, 255, 255, 0.025);
		color: var(--color-ws-text, #9a9aa8);
		cursor: pointer;
		font-family: inherit;
		font-size: 11px;
		font-weight: 700;
		transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
	}

	.workspace-pipeline-panel button:hover {
		border-color: rgba(124, 92, 255, 0.35);
		background: rgba(124, 92, 255, 0.1);
		color: var(--color-ws-ink, #ececf2);
	}

	.workspace-pipeline-grid,
	.workspace-pipeline-panel.chapter .workspace-pipeline-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr));
		gap: clamp(8px, 1.1vw, 12px);
	}

	.workspace-pipeline-card {
		display: grid;
		align-content: space-between;
		gap: 10px;
		min-width: 0;
		min-height: 132px;
		padding: 12px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-card, 12px);
		background: #14141b;
	}

	.workspace-pipeline-panel.story .workspace-pipeline-card {
		min-height: 138px;
	}

	/* calm dark cards with just a colored top-edge accent — matches the rest of the
	   ws surfaces instead of vivid full-card tints. */
	.workspace-pipeline-card.teal { border-color: rgba(34, 211, 238, 0.22); box-shadow: inset 0 2px 0 rgba(34, 211, 238, 0.5); }
	.workspace-pipeline-card.cyan { border-color: rgba(34, 211, 238, 0.22); box-shadow: inset 0 2px 0 rgba(34, 211, 238, 0.5); }
	.workspace-pipeline-card.blue { border-color: rgba(143, 184, 255, 0.22); box-shadow: inset 0 2px 0 rgba(143, 184, 255, 0.5); }
	.workspace-pipeline-card.violet { border-color: rgba(124, 92, 255, 0.24); box-shadow: inset 0 2px 0 rgba(139, 92, 246, 0.55); }
	.workspace-pipeline-card.amber { border-color: rgba(251, 191, 36, 0.22); box-shadow: inset 0 2px 0 rgba(251, 191, 36, 0.5); }
	.workspace-pipeline-card.green { border-color: rgba(52, 211, 153, 0.22); box-shadow: inset 0 2px 0 rgba(52, 211, 153, 0.5); }

	.pipeline-copy {
		display: grid;
		gap: 4px;
		min-width: 0;
	}

	.pipeline-copy span {
		color: var(--color-ws-text, #9a9aa8);
		font-size: 11px;
		font-weight: 800;
	}

	.pipeline-copy strong {
		color: var(--color-ws-ink, #ececf2);
		font-size: 13px;
		font-weight: 800;
		line-height: 1.18;
		overflow-wrap: anywhere;
	}

	.pipeline-copy small {
		color: var(--color-ws-faint, #6b6b78);
		font-size: 10px;
		font-weight: 700;
		line-height: 1.25;
	}

	.pipeline-avatar-stack {
		display: flex;
		min-height: 24px;
		align-items: center;
	}

	.pipeline-avatar-stack i {
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		margin-left: -5px;
		border: 1px solid rgba(255, 255, 255, 0.16);
		border-radius: 999px;
		background: linear-gradient(135deg, #7c5cff, #d946ef);
		color: #fff;
		font-size: 10px;
		font-style: normal;
		font-weight: 800;
	}

	.pipeline-avatar-stack i:first-child {
		margin-left: 0;
	}

	.pipeline-meter {
		position: relative;
		height: 6px;
		overflow: hidden;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.07);
	}

	.workspace-pipeline-panel.story .pipeline-meter {
		height: 5px;
	}

	.pipeline-meter i {
		position: absolute;
		inset: 0 auto 0 0;
		border-radius: inherit;
		background: linear-gradient(90deg, #8b5cf6, #d946ef);
	}
</style>
