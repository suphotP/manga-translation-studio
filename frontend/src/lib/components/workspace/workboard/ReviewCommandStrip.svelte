<script lang="ts">
	import { _ } from "$lib/i18n";
	import type { TaskFocusItem } from "$lib/project/task-focus-queue.js";
	import type { WorkInboxItem } from "$lib/project/work-inbox.js";

	type ReviewCommandTone = "hot" | "warn" | "ready" | "idle";
	type ReviewCommandFilter = "comments" | "ai-qc" | "review" | "blockers" | "workflow" | "all";

	interface ReviewCommand {
		id: string;
		label: string;
		count: number;
		detail: string;
		tone: ReviewCommandTone;
		item: TaskFocusItem | null;
		filter: ReviewCommandFilter;
	}

	interface Props {
		variant: "solo" | "team";
		reviewCommands: readonly ReviewCommand[];
		reviewCommandAriaLabel: (command: { id: string; label: string }) => string;
		workItemCanvasActionLabel: (item: TaskFocusItem | WorkInboxItem | null) => string;
		onFocusReviewCommand: (command: ReviewCommand) => void;
		onOpenReviewCommandInEditor: (command: ReviewCommand) => void;
	}

	let {
		variant,
		reviewCommands,
		reviewCommandAriaLabel,
		workItemCanvasActionLabel,
		onFocusReviewCommand,
		onOpenReviewCommandInEditor,
	}: Props = $props();
</script>

{#if variant === "solo"}
	<section class="solo-review-strip ws-panel" aria-label={$_("workBoard.cmdSoloReviewSummary")}>
		<div class="review-command-head">
			<span>{$_("workBoard.cmdReviewWhenNeeded")}</span>
			<strong>{$_("workBoard.cmdReviewPagesNotesAi")}</strong>
		</div>
		{#each reviewCommands as command (command.id)}
			<article class={`review-command-card ws-panel-quiet ${command.tone}`} role="group" aria-label={reviewCommandAriaLabel(command)}>
				<div class="review-command-copy">
					<span>{command.label}</span>
					<strong>{command.count}</strong>
					<small>{command.detail}</small>
				</div>
				<div class="review-command-actions">
					{#if command.item}
						<button type="button" class="primary ws-grad-primary" onclick={() => onFocusReviewCommand(command)}>
							{$_("workBoard.doThisWork")}
						</button>
						<details class="work-row-more">
							<summary class="ws-btn-ghost">{$_("workBoard.more")}</summary>
							<div class="work-row-more-menu">
								<button type="button" class="ws-btn-ghost" onclick={() => onOpenReviewCommandInEditor(command)}>
									{workItemCanvasActionLabel(command.item)}
								</button>
							</div>
						</details>
					{:else}
						<span class="action-receipt ready ws-grad-primary-soft">{$_("workBoard.cleared")}</span>
					{/if}
				</div>
			</article>
		{/each}
	</section>
{:else}
	<section class="review-command-strip ws-panel" aria-label={$_("workBoard.cmdReviewCenter")}>
		<div class="review-command-head">
			<span>{$_("workBoard.checkPages")}</span>
			<strong>{$_("workBoard.cmdReviewPageStep")}</strong>
		</div>
		{#each reviewCommands as command (command.id)}
			<article class={`review-command-card ws-panel-quiet ${command.tone}`} role="group" aria-label={reviewCommandAriaLabel(command)}>
				<div class="review-command-copy">
					<span>{command.label}</span>
					<strong>{command.count}</strong>
					<small>{command.detail}</small>
				</div>
				<div class="review-command-actions">
					{#if command.item}
						<button type="button" class="primary ws-grad-primary" onclick={() => onFocusReviewCommand(command)}>
							{$_("workBoard.doThisWork")}
						</button>
						<details class="work-row-more">
							<summary class="ws-btn-ghost">{$_("workBoard.more")}</summary>
							<div class="work-row-more-menu">
								<button type="button" class="ws-btn-ghost" onclick={() => onOpenReviewCommandInEditor(command)}>
									{workItemCanvasActionLabel(command.item)}
								</button>
							</div>
						</details>
					{:else}
						<span class="action-receipt ready ws-grad-primary-soft">{$_("workBoard.cleared")}</span>
					{/if}
				</div>
			</article>
		{/each}
	</section>
{/if}

<style>
	.solo-review-strip,
	.review-command-strip {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface) 86%, transparent);
		color: var(--color-ws-ink);
	}

	.review-command-head,
	.review-command-card {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface2) 62%, transparent);
	}

	.review-command-head span,
	.review-command-copy span {
		color: var(--color-ws-violet);
	}

	.review-command-head strong,
	.review-command-copy strong {
		color: var(--color-ws-ink);
	}

	.review-command-copy small {
		color: var(--color-ws-text);
	}

	.review-command-card.hot {
		border-color: color-mix(in srgb, var(--color-ws-rose) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 12%, var(--color-ws-surface) 88%);
	}

	.review-command-card.warn {
		border-color: color-mix(in srgb, var(--color-ws-amber) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 12%, var(--color-ws-surface) 88%);
	}

	.review-command-card.ready {
		border-color: color-mix(in srgb, var(--color-ws-green) 32%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 10%, var(--color-ws-surface) 90%);
	}

	.review-command-card.idle {
		border-color: var(--ws-hair);
	}

	.review-command-actions button,
	.work-row-more summary,
	.work-row-more-menu button {
		min-height: 38px;
		border-radius: var(--radius-ws-ctrl);
		border: 1px solid var(--ws-hair);
		color: var(--color-ws-ink);
		font-family: inherit;
	}

	.review-command-actions button.primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 52%, transparent);
	}

	.work-row-more[open] summary,
	.work-row-more-menu {
		border-color: color-mix(in srgb, var(--color-ws-accent) 35%, transparent);
		background: var(--color-ws-surface);
	}

	.action-receipt.ready {
		border: 1px solid color-mix(in srgb, var(--color-ws-green) 30%, transparent);
		border-radius: var(--radius-ws-ctrl);
		color: var(--color-ws-ink);
	}
</style>
