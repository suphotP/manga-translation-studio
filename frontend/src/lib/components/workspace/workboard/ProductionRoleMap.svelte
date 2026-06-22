<script lang="ts">
	import { _ } from "$lib/i18n";
	import type { WorkspaceJobLane } from "$lib/project/workspace-dashboard.js";

	type ProductionPageTone = "ready" | "warn" | "raw";

	interface ProductionRoleCard {
		id: string;
		title: string;
		lane: string;
		detail: string;
		taskType: WorkspaceJobLane["id"];
	}

	interface PageProductionSummary {
		pageIndex: number;
		pageLabel: string;
		imageName: string;
		cleanLabel: string;
		cleanTone: ProductionPageTone;
		translatorLabel: string;
		translatorTone: ProductionPageTone;
		typesetLabel: string;
		typesetTone: ProductionPageTone;
		qcLabel: string;
		qcTone: ProductionPageTone;
		nextRoleId: string | null;
		nextRoleLabel: string;
	}

	interface MainProjectHandoffSummary {
		ready: boolean;
		title: string;
		detail: string;
		action: string;
		nextRoleId: string | null;
		nextPageIndex: number | null;
		cleanLabel: string;
		cleanTone: ProductionPageTone;
		typesetLabel: string;
		typesetTone: ProductionPageTone;
		qcLabel: string;
		qcTone: ProductionPageTone;
		creditLabel: string;
		creditTone: ProductionPageTone;
	}

	interface CompletedTaskReconciliation {
		taskIds: string[];
		translateCount: number;
		cleanCount: number;
		typesetCount: number;
		reviewCount: number;
		reviewNeedsFinalQcCount: number;
	}

	interface Props {
		productionRoleCards: readonly ProductionRoleCard[];
		selectedProductionRoleId: string | null;
		currentPageProductionHandoff: PageProductionSummary | null;
		currentPageIndex: number | null;
		pageProductionSummaries: PageProductionSummary[];
		pageProductionOverflowCount: number;
		mainProjectHandoff: MainProjectHandoffSummary;
		completedTaskReconciliation: CompletedTaskReconciliation;
		productionRoleCount: (card: ProductionRoleCard) => string;
		productionRoleButtonLabel: (card: ProductionRoleCard) => string;
		currentPageHandoffActionLabel: string;
		productionPageOpenLabel: (summary: PageProductionSummary) => string;
		onSelectProductionRole: (card: ProductionRoleCard) => void;
		onOpenCurrentPageProductionHandoff: () => void;
		onSelectProductionPage: (summary: PageProductionSummary) => void;
		onOpenMainProjectHandoff: () => void;
		onReconcileCompletedWorkflowTasks: () => void;
	}

	let {
		productionRoleCards,
		selectedProductionRoleId,
		currentPageProductionHandoff,
		currentPageIndex,
		pageProductionSummaries,
		pageProductionOverflowCount,
		mainProjectHandoff,
		completedTaskReconciliation,
		productionRoleCount,
		productionRoleButtonLabel,
		currentPageHandoffActionLabel,
		productionPageOpenLabel,
		onSelectProductionRole,
		onOpenCurrentPageProductionHandoff,
		onSelectProductionPage,
		onOpenMainProjectHandoff,
		onReconcileCompletedWorkflowTasks,
	}: Props = $props();
</script>

<section class="production-role-map ws-panel" aria-label={$_("productionRoleMap.sectionAria")}>
	<div class="production-role-head">
		<span>{$_("productionRoleMap.teamHead")}</span>
		<strong>{$_("productionRoleMap.teamSubhead")}</strong>
	</div>
	{#if currentPageProductionHandoff}
		<div class="current-page-handoff ws-panel-quiet" role="region" aria-label={$_("productionRoleMap.currentPageHandoffAria")}>
			<div class="current-page-handoff-copy">
				<span>{$_("productionRoleMap.currentPage")}</span>
				<strong>{currentPageProductionHandoff.pageLabel} · {$_("productionRoleMap.nextPrefix")} {currentPageProductionHandoff.nextRoleLabel}</strong>
				<small>{currentPageProductionHandoff.imageName}</small>
			</div>
			<div class="current-page-handoff-states" aria-label={$_("productionRoleMap.handoffStatusAria", { values: { page: currentPageProductionHandoff.pageLabel } })}>
				<span class={currentPageProductionHandoff.cleanTone}>{$_("productionRoleMap.stateClean")} {currentPageProductionHandoff.cleanLabel}</span>
				<span class={currentPageProductionHandoff.translatorTone}>{$_("productionRoleMap.stateTranslate")} {currentPageProductionHandoff.translatorLabel}</span>
				<span class={currentPageProductionHandoff.typesetTone}>{$_("productionRoleMap.stateTypeset")} {currentPageProductionHandoff.typesetLabel}</span>
				<span class={currentPageProductionHandoff.qcTone}>{$_("productionRoleMap.stateQc")} {currentPageProductionHandoff.qcLabel}</span>
			</div>
			<button type="button" class="ws-btn-ghost" class:primary={Boolean(currentPageProductionHandoff.nextRoleId)} onclick={onOpenCurrentPageProductionHandoff}>
				{currentPageHandoffActionLabel}
			</button>
		</div>
	{/if}
	<div class="production-role-grid" aria-label={$_("productionRoleMap.selectRoleAria")}>
		{#each productionRoleCards as card (card.id)}
			<article class="ws-panel-quiet" class:active={card.id === selectedProductionRoleId} title={card.detail}>
				<div>
					<span>{card.lane}</span>
					<strong>{card.title}</strong>
				</div>
				<div class="production-role-action">
					<em>{productionRoleCount(card)}</em>
					<button type="button" class="ws-btn-ghost" aria-label={$_("productionRoleMap.selectRoleCardAria", { values: { role: card.title } })} onclick={() => onSelectProductionRole(card)}>
						{productionRoleButtonLabel(card)}
					</button>
				</div>
			</article>
		{/each}
	</div>
	{#if pageProductionSummaries.length}
		<details class="production-page-handoff ws-panel-quiet" role="region" aria-label={$_("productionRoleMap.pageHandoffAria")}>
			<summary class="production-page-head">
				<span>{$_("productionRoleMap.pageHandoffHead")}</span>
				<strong>{$_("productionRoleMap.pageHandoffSubhead")}</strong>
				<small>
					{#if pageProductionOverflowCount > 0}
						{$_("productionRoleMap.pageOverflow", { values: { count: pageProductionOverflowCount } })}
					{:else}
						{$_("productionRoleMap.pageHandoffHint")}
					{/if}
				</small>
			</summary>
			<div class="production-page-grid">
				{#each pageProductionSummaries as summary (summary.pageIndex)}
					<article class="ws-panel-quiet" class:active={summary.pageIndex === currentPageIndex}>
						<div class="production-page-title">
							<span>{summary.pageLabel}</span>
							<strong>{summary.imageName}</strong>
							<small>{$_("productionRoleMap.nextPrefix")} {summary.nextRoleLabel}</small>
						</div>
						<div class="production-page-states" aria-label={$_("productionRoleMap.pageStatesAria", { values: { page: summary.pageLabel } })}>
							<span class={summary.cleanTone}>{$_("productionRoleMap.stateClean")} {summary.cleanLabel}</span>
							<span class={summary.translatorTone}>{$_("productionRoleMap.stateTranslate")} {summary.translatorLabel}</span>
							<span class={summary.typesetTone}>{$_("productionRoleMap.stateTypeset")} {summary.typesetLabel}</span>
							<span class={summary.qcTone}>{$_("productionRoleMap.stateQc")} {summary.qcLabel}</span>
						</div>
						<button type="button" class="ws-btn-ghost" onclick={() => onSelectProductionPage(summary)}>
							{productionPageOpenLabel(summary)}
						</button>
					</article>
				{/each}
			</div>
		</details>
	{/if}
	<div class={`main-project-handoff ws-panel-quiet ${mainProjectHandoff.ready ? "ready" : "warn"}`} role="region" aria-label={$_("productionRoleMap.mainHandoffAria")}>
		<div class="main-project-handoff-copy">
			<span>{$_("productionRoleMap.mainHandoffHead")}</span>
			<strong>{mainProjectHandoff.title}</strong>
			<small>{mainProjectHandoff.detail}</small>
		</div>
		<div class="main-project-handoff-checks" aria-label={$_("productionRoleMap.mainHandoffChecksAria")}>
			<span class={mainProjectHandoff.cleanTone}>{$_("productionRoleMap.stateClean")} {mainProjectHandoff.cleanLabel}</span>
			<span class={mainProjectHandoff.typesetTone}>{$_("productionRoleMap.stateTypeset")} {mainProjectHandoff.typesetLabel}</span>
			<span class={mainProjectHandoff.qcTone}>{$_("productionRoleMap.stateQc")} {mainProjectHandoff.qcLabel}</span>
			<span class={mainProjectHandoff.creditTone}>{$_("productionRoleMap.stateCredit")} {mainProjectHandoff.creditLabel}</span>
		</div>
		<button type="button" class="ws-btn-ghost" class:primary={mainProjectHandoff.ready} onclick={onOpenMainProjectHandoff}>
			{mainProjectHandoff.action}
		</button>
	</div>
	{#if completedTaskReconciliation.taskIds.length}
		<div class="team-task-reconcile ws-panel-quiet" role="region" aria-label={$_("productionRoleMap.reconcileAria")}>
			<div class="team-task-reconcile-copy">
				<span>{$_("productionRoleMap.reconcileHead")}</span>
				<strong>{$_("productionRoleMap.reconcileSubhead", { values: { count: completedTaskReconciliation.taskIds.length } })}</strong>
				<small>
					{completedTaskReconciliation.reviewNeedsFinalQcCount
						? $_("productionRoleMap.reconcileHintNeedsQc")
						: $_("productionRoleMap.reconcileHint")}
				</small>
			</div>
			<div class="team-task-reconcile-states" aria-label={$_("productionRoleMap.reconcileStatesAria")}>
				{#if completedTaskReconciliation.translateCount}
					<span>{$_("productionRoleMap.stateTranslate")} {completedTaskReconciliation.translateCount}</span>
				{/if}
				{#if completedTaskReconciliation.cleanCount}
					<span>{$_("productionRoleMap.stateClean")} {completedTaskReconciliation.cleanCount}</span>
				{/if}
				{#if completedTaskReconciliation.typesetCount}
					<span>{$_("productionRoleMap.stateTypeset")} {completedTaskReconciliation.typesetCount}</span>
				{/if}
				{#if completedTaskReconciliation.reviewCount}
					<span>{$_("productionRoleMap.stateQc")} {completedTaskReconciliation.reviewCount}</span>
				{/if}
				{#if completedTaskReconciliation.reviewNeedsFinalQcCount}
					<span class="warn">{$_("productionRoleMap.stateQcMore")} {completedTaskReconciliation.reviewNeedsFinalQcCount}</span>
				{/if}
			</div>
			<button type="button" class="ws-btn-ghost" onclick={onReconcileCompletedWorkflowTasks}>
				{$_("productionRoleMap.closeCompleted")}
			</button>
		</div>
	{/if}
</section>

<style>
	.production-role-map {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface) 86%, transparent);
		color: var(--color-ws-ink);
	}

	.production-role-head span,
	.production-role-grid span,
	.current-page-handoff-copy span,
	.main-project-handoff-copy span,
	.team-task-reconcile-copy span,
	.production-page-title span,
	.production-page-head span {
		color: var(--color-ws-violet);
	}

	.production-role-head strong,
	.production-role-grid strong,
	.current-page-handoff-copy strong,
	.main-project-handoff-copy strong,
	.team-task-reconcile-copy strong,
	.production-page-title strong,
	.production-page-head strong {
		color: var(--color-ws-ink);
	}

	.current-page-handoff-copy small,
	.main-project-handoff-copy small,
	.team-task-reconcile-copy small,
	.production-page-title small,
	.production-page-head small {
		color: var(--color-ws-text);
	}

	.production-role-grid article,
	.current-page-handoff,
	.production-page-handoff,
	.production-page-grid article,
	.main-project-handoff,
	.team-task-reconcile {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface2) 62%, transparent);
	}

	.production-role-grid article.active,
	.production-page-grid article.active,
	.main-project-handoff.ready {
		border-color: color-mix(in srgb, var(--color-ws-green) 32%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 10%, var(--color-ws-surface) 90%);
	}

	.current-page-handoff,
	.main-project-handoff.warn {
		border-color: color-mix(in srgb, var(--color-ws-amber) 30%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 10%, var(--color-ws-surface) 90%);
	}

	.current-page-handoff-states span,
	.production-page-states span,
	.main-project-handoff-checks span,
	.team-task-reconcile-states span {
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 68%, transparent);
		color: var(--color-ws-text);
	}

	.current-page-handoff-states span.ready,
	.production-page-states span.ready,
	.main-project-handoff-checks span.ready {
		border-color: color-mix(in srgb, var(--color-ws-green) 30%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 12%, transparent);
		color: var(--color-ws-green);
	}

	.current-page-handoff-states span.warn,
	.production-page-states span.warn,
	.main-project-handoff-checks span.warn,
	.team-task-reconcile-states span.warn {
		border-color: color-mix(in srgb, var(--color-ws-amber) 32%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 12%, transparent);
		color: var(--color-ws-amber);
	}

	.current-page-handoff button,
	.production-role-action button,
	.production-page-grid button,
	.main-project-handoff button,
	.team-task-reconcile button {
		min-height: 38px;
		border-radius: var(--radius-ws-ctrl);
		border: 1px solid var(--ws-hair);
		color: var(--color-ws-ink);
		font-family: inherit;
	}

	.current-page-handoff button.primary,
	.main-project-handoff button.primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 52%, transparent);
		background: linear-gradient(100deg, var(--color-ws-violet) 0%, var(--color-ws-accent) 100%);
	}
</style>
