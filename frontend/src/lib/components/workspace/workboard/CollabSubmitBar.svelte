<script lang="ts">
	// Collab v1 surface for the Work Board:
	//  1) Role-aware "Submit / Mark done" — advances the open stage of the current
	//     page to the next pipeline stage (Clean → Translate → Typeset → QC) and
	//     opens it for the next role, replacing free-form status flips.
	//  2) Soft presence badge — "👤 X is editing" when another user has a recent
	//     heartbeat on this page. Informational only; never blocks editing.
	//
	// Both work in file-mode (no Postgres). Presence is a best-effort TTL ping.
	import { _ } from "$lib/i18n";
	import { onDestroy } from "svelte";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { presenceStore } from "$lib/stores/presence.svelte.ts";
	import {
		TASK_PIPELINE_ORDER,
		planStageAdvance,
		type StageAdvancePlan,
	} from "$lib/project/task-stage-advance.js";
	import type { WorkflowTask, WorkflowTaskType } from "$lib/types.js";

	// Localized role + stage labels keyed off the i18n bundle so EN shows English.
	function stageLabel(type: WorkflowTaskType): string {
		return $_(`collab.stage.${type}`);
	}
	function roleLabel(type: WorkflowTaskType): string {
		return $_(`collab.role.${type}`);
	}

	let project = $derived(projectStore.project);
	let currentPageIndex = $derived(project?.currentPage ?? null);

	// The page's OPEN stage = the earliest pipeline stage on this page whose task
	// is not yet done. That's the work the current owner would "submit".
	let activeStageTask = $derived(resolveActiveStageTask());
	let advancePlan = $derived(activeStageTask ? planStageAdvance(activeStageTask, projectStore.tasks) : null);
	let others = $derived(presenceStore.others);

	let confirmOpen = $state(false);
	let submitting = $state(false);
	let lastResult = $state<StageAdvancePlan | null>(null);

	function resolveActiveStageTask(): WorkflowTask | null {
		if (currentPageIndex === null) return null;
		const pageTasks = projectStore.tasks.filter((task) => task.pageIndex === currentPageIndex);
		for (const type of TASK_PIPELINE_ORDER) {
			const task = pageTasks.find((candidate) => candidate.type === type);
			if (task && task.status !== "done") return task;
		}
		return null;
	}

	// ── Presence heartbeat lifecycle ───────────────────────────────
	// Watch the current page scope so others see "you are editing", and we see
	// them. Re-watches whenever the open page changes; clears on destroy.
	$effect(() => {
		if (!project || currentPageIndex === null) {
			presenceStore.stop();
			return;
		}
		presenceStore.watch({
			projectId: project.projectId,
			scope: "page",
			scopeId: String(currentPageIndex),
		});
	});

	onDestroy(() => presenceStore.stop());

	function openConfirm(): void {
		if (!advancePlan) return;
		confirmOpen = true;
	}

	function cancelConfirm(): void {
		confirmOpen = false;
	}

	async function confirmSubmit(): Promise<void> {
		if (!activeStageTask) return;
		submitting = true;
		try {
			const result = await projectStore.submitTaskToNextStage(activeStageTask.id);
			if (result) {
				lastResult = result;
				if (result.terminal) {
					projectStore.setStatusMsg($_("collab.submit.doneFinal", { values: { stage: stageLabel(result.currentType) } }));
				} else if (result.nextType) {
					projectStore.setStatusMsg(
						$_("collab.submit.advanced", {
							values: { from: stageLabel(result.currentType), to: stageLabel(result.nextType), role: roleLabel(result.nextType) },
						}),
					);
				}
			}
		} finally {
			submitting = false;
			confirmOpen = false;
		}
	}

	function presenceLabel(): string {
		if (others.length === 1) {
			return $_("collab.presence.one", { values: { name: others[0].name } });
		}
		return $_("collab.presence.many", { values: { name: others[0].name, count: others.length - 1 } });
	}
</script>

{#if project}
	<section class="collab-bar ws-panel" aria-label={$_("collab.bar.label")}>
		<div class="collab-stage">
			<span class="collab-eyebrow">{$_("collab.bar.eyebrow")}</span>
			{#if activeStageTask && advancePlan}
				<strong>{stageLabel(activeStageTask.type)} · {$_("collab.bar.pageWord")} {activeStageTask.pageIndex + 1}</strong>
				<small>
					{#if advancePlan.terminal}
						{$_("collab.bar.terminalHint")}
					{:else if advancePlan.nextType}
						{$_("collab.bar.nextHint", { values: { stage: stageLabel(advancePlan.nextType), role: roleLabel(advancePlan.nextType) } })}
					{/if}
				</small>
			{:else}
				<strong>{$_("collab.bar.allDoneTitle")}</strong>
				<small>{$_("collab.bar.allDoneHint")}</small>
			{/if}
		</div>

		<div class="collab-side">
			{#if others.length}
				<span class="presence-badge ws-grad-primary-soft" title={others.map((entry) => entry.name).join(", ")}>
					<span aria-hidden="true">👤</span>
					{presenceLabel()}
				</span>
			{/if}
			{#if activeStageTask}
				<button type="button" class="collab-submit ws-grad-primary" onclick={openConfirm} disabled={submitting || projectStore.workflowLoading}>
					{advancePlan?.terminal ? $_("collab.submit.finalButton") : $_("collab.submit.button")}
				</button>
			{/if}
		</div>
	</section>

	{#if confirmOpen && advancePlan}
		<div
			class="collab-modal-backdrop"
			role="presentation"
			onclick={cancelConfirm}
			onkeydown={(event) => { if (event.key === "Escape") cancelConfirm(); }}
		>
			<div
				class="collab-modal ws-panel"
				role="dialog"
				tabindex="-1"
				aria-modal="true"
				aria-label={$_("collab.confirm.title")}
				onclick={(event) => event.stopPropagation()}
				onkeydown={(event) => { if (event.key === "Escape") cancelConfirm(); }}
			>
				<h2>{$_("collab.confirm.title")}</h2>
				<p>
					{#if advancePlan.terminal}
						{$_("collab.confirm.finalBody", { values: { stage: stageLabel(advancePlan.currentType), page: advancePlan.pageIndex + 1 } })}
					{:else if advancePlan.nextType}
						{$_("collab.confirm.body", {
							values: {
								from: stageLabel(advancePlan.currentType),
								to: stageLabel(advancePlan.nextType),
								role: roleLabel(advancePlan.nextType),
								page: advancePlan.pageIndex + 1,
							},
						})}
					{/if}
				</p>
				{#if !advancePlan.terminal && advancePlan.nextType}
					<div class="collab-result-chip ws-grad-primary-soft">
						{$_("collab.confirm.resultLabel")}: <strong>{stageLabel(advancePlan.nextType)}</strong>
					</div>
				{/if}
				<div class="collab-modal-actions">
					<button type="button" class="ghost ws-btn-ghost" onclick={cancelConfirm} disabled={submitting}>{$_("collab.confirm.cancel")}</button>
					<button type="button" class="primary ws-grad-primary" onclick={() => void confirmSubmit()} disabled={submitting}>
						{submitting ? $_("collab.confirm.submitting") : $_("collab.confirm.confirm")}
					</button>
				</div>
			</div>
		</div>
	{/if}
{/if}

<style>
	.collab-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: clamp(0.5rem, 2vw, 1rem);
		padding: clamp(0.65rem, 1.6vw, 0.95rem) clamp(0.85rem, 2vw, 1.15rem);
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-surface) 86%, transparent);
		color: var(--color-ws-ink);
	}
	.collab-stage {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}
	.collab-eyebrow {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--color-ws-violet);
	}
	.collab-stage strong {
		font-size: clamp(0.95rem, 2.4vw, 1.1rem);
		color: var(--color-ws-ink);
	}
	.collab-stage small {
		font-size: 0.8rem;
		color: var(--color-ws-text);
	}
	.collab-side {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.presence-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.3rem 0.6rem;
		border-radius: var(--radius-ws-ctrl);
		font-size: 0.8rem;
		background: color-mix(in srgb, var(--color-ws-amber) 14%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-amber) 32%, transparent);
		color: var(--color-ws-ink);
		white-space: nowrap;
	}
	.collab-submit {
		min-height: 38px;
		padding: 0.5rem 0.9rem;
		border-radius: var(--radius-ws-ctrl);
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 55%, transparent);
		color: var(--color-ws-ink);
		font-weight: 600;
		cursor: pointer;
	}
	.collab-submit:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.collab-modal-backdrop {
		position: fixed;
		inset: 0;
		display: grid;
		place-items: center;
		background: color-mix(in srgb, var(--color-ws-bg) 72%, transparent);
		z-index: 60;
		padding: 1rem;
	}
	.collab-modal {
		width: min(28rem, 100%);
		background: var(--color-ws-surface);
		color: inherit;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws);
		padding: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}
	.collab-modal h2 {
		font-size: 1.05rem;
		margin: 0;
		color: var(--color-ws-ink);
	}
	.collab-modal p {
		margin: 0;
		font-size: 0.9rem;
		line-height: 1.5;
		color: var(--color-ws-text);
	}
	.collab-result-chip {
		font-size: 0.85rem;
		padding: 0.4rem 0.7rem;
		border-radius: var(--radius-ws-ctrl);
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 30%, transparent);
		color: var(--color-ws-ink);
		align-self: flex-start;
	}
	.collab-modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
		margin-top: 0.25rem;
	}
	.collab-modal-actions button {
		min-height: 38px;
		padding: 0.5rem 0.95rem;
		border-radius: var(--radius-ws-ctrl);
		cursor: pointer;
		font-weight: 600;
	}
	.collab-modal-actions .ghost {
		border: 1px solid var(--ws-hair);
		color: inherit;
	}
	.collab-modal-actions .primary {
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 55%, transparent);
		color: var(--color-ws-ink);
	}
	.collab-modal-actions button:disabled {
		opacity: 0.55;
		cursor: default;
	}
</style>
