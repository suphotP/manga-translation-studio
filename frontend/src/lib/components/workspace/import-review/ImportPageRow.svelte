<!-- ImportPageRow - per-page review row used by WorkspaceImportReviewView.
	Pure presentation extraction. Keep the compact row grid stable while routing
	the visual treatment through the shared ws-* dark theme tokens. -->
<script lang="ts">
	import type { PageWorkSummary } from "$lib/project/page-work-summary.js";

	let {
		summary,
		active,
		title,
		status,
		hint,
		signal,
		actionLabel,
		assetLabel,
		needsRecovery,
		recoveryLabel,
		onOpen,
		onRelink,
	}: {
		summary: PageWorkSummary;
		active: boolean;
		title: string;
		status: string;
		hint: string;
		signal: string;
		actionLabel: string;
		assetLabel: string;
		needsRecovery: boolean;
		recoveryLabel: string;
		onOpen: () => void;
		onRelink: () => void;
	} = $props();
</script>

<article class:active>
	<div class="page-number">
		<span>P{summary.pageNumber}</span>
	</div>
	<div class="page-copy">
		<strong title={summary.name}>{title}</strong>
		<small>{hint}</small>
	</div>
	<div class="page-state">
		<span>
			{status}
			{#if summary.assetIntegrity}
				<small class={`asset-chip ${summary.assetIntegrity.status}`} title={summary.assetIntegrity.detail}>
					{assetLabel}
				</small>
			{/if}
		</span>
		<small>{signal}</small>
	</div>
	<div class="row-actions">
		<button type="button" class="row-open ws-btn-ghost" onclick={onOpen}>{actionLabel}</button>
		{#if needsRecovery}
			<button type="button" class="relink ws-btn-ghost" onclick={onRelink}>{recoveryLabel}</button>
		{/if}
	</div>
</article>

<style>
	article {
		display: grid;
		grid-template-columns: 58px minmax(0, 1fr) minmax(150px, 0.7fr) auto;
		gap: 10px;
		align-items: center;
		min-width: 0;
		padding: 10px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface2) 58%, transparent);
	}

	article.active {
		border-color: color-mix(in srgb, var(--color-ws-accent) 45%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 10%, transparent);
	}

	.page-number {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 42px;
		height: 42px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 86%, transparent);
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 900;
	}

	.page-copy,
	.page-state {
		display: grid;
		min-width: 0;
		gap: 4px;
	}

	.page-copy strong,
	.page-copy small,
	.page-state small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.page-copy strong {
		color: var(--color-ws-ink);
		font-size: 13px;
		font-weight: 850;
	}

	.page-copy small,
	.page-state small {
		color: var(--color-ws-text);
		font-size: 11px;
		font-weight: 720;
	}

	.page-state span {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		color: var(--color-ws-ink);
		font-size: 12px;
		font-weight: 850;
	}

	.asset-chip {
		--asset-tone: var(--color-ws-text);

		display: inline-flex;
		max-width: 110px;
		align-items: center;
		padding: 3px 7px;
		border: 1px solid color-mix(in srgb, var(--asset-tone) 22%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--asset-tone) 10%, transparent);
		color: var(--asset-tone);
		font-size: 10px;
		font-weight: 850;
		line-height: 1;
		text-transform: uppercase;
	}

	.asset-chip.ready {
		--asset-tone: var(--color-ws-green);
	}

	.asset-chip.failed,
	.asset-chip.missing,
	.asset-chip.blocked {
		--asset-tone: var(--color-ws-rose);
	}

	.asset-chip.scanning {
		--asset-tone: var(--color-ws-amber);
	}

	.row-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 6px;
	}

	.row-actions button {
		display: inline-flex;
		min-height: 40px;
		align-items: center;
		justify-content: center;
		padding: 0 12px;
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-ink);
		cursor: pointer;
		font-size: 12px;
		font-weight: 850;
		font-family: inherit;
	}

	.row-actions .relink {
		border-color: color-mix(in srgb, var(--color-ws-rose) 32%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 12%, transparent);
		color: var(--color-ws-rose);
	}

	/* Matches the original `@media (max-width: 980px)` rules from
		WorkspaceImportReviewView for `.target-list article`, `.page-state`,
		`.row-actions`. */
	@media (max-width: 980px) {
		article {
			grid-template-columns: 52px minmax(0, 1fr) minmax(150px, 0.7fr) auto;
			padding: 8px;
		}

		.page-state {
			grid-column: auto;
		}

		.row-actions {
			grid-column: auto;
			grid-row: auto;
			align-self: center;
		}
	}

	/* Matches original `@media (max-width: 720px)`. */
	@media (max-width: 720px) {
		article {
			grid-template-columns: 52px minmax(0, 1fr) auto;
		}

		.page-state {
			grid-column: 2 / 3;
		}

		.row-actions {
			grid-column: 3;
			grid-row: 1 / 3;
		}
	}

	/* Matches original `@media (max-width: 560px)`. */
	@media (max-width: 560px) {
		article {
			grid-template-columns: 1fr;
		}

		.row-actions button {
			width: 100%;
		}

		.page-state {
			grid-column: auto;
		}

		.row-actions {
			grid-column: auto;
			grid-row: auto;
			justify-content: stretch;
		}

		.row-actions button {
			flex: 1 1 0;
		}
	}
</style>
