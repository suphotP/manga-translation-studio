<script lang="ts">
	import { _ } from "$lib/i18n";
	import { formatAssigneeHandle } from "$lib/project/assignees.js";
	import { formatWorkflowDueDay } from "$lib/project/task-due.js";
	import type { WorkspaceJobLane } from "$lib/project/workspace-dashboard.js";

	interface Props {
		lanes: readonly WorkspaceJobLane[];
		emptyLaneLabels?: Partial<Record<WorkspaceJobLane["id"], string>>;
		soloAssigneeLabel?: string;
		onOpenLane: (lane: WorkspaceJobLane) => void | Promise<void>;
	}

	let { lanes, emptyLaneLabels = {}, soloAssigneeLabel = $_("jobLanes.soloMode"), onOpenLane }: Props = $props();

	let primaryLane = $derived(lanes.find((lane) => lane.openCount > 0) ?? lanes[0] ?? null);
	let secondaryLanes = $derived(primaryLane ? lanes.filter((lane) => lane.id !== primaryLane.id) : []);

	function laneAction(lane: WorkspaceJobLane): string {
		if (lane.firstOpenTaskTitle) return laneTaskTitle(lane);
		if (lane.totalCount === 0) return emptyLaneLabels[lane.id] ?? $_("jobLanes.noTasks");
		if (lane.openCount === 0) return $_("jobLanes.allDone");
		return $_("jobLanes.nextTask");
	}

	function laneTaskTitle(lane: WorkspaceJobLane): string {
		const page =
			lane.firstOpenPageIndex === null
				? $_("jobLanes.wholeChapter")
				: $_("jobLanes.pageN", { values: { n: lane.firstOpenPageIndex + 1 } });
		const title = lane.firstOpenTaskTitle ?? "";
		if (/^Translate page \d+$/i.test(title)) return $_("jobLanes.titleTranslate", { values: { page } });
		if (/^Clean page \d+$/i.test(title)) return $_("jobLanes.titleClean", { values: { page } });
		if (/^Typeset page \d+$/i.test(title)) return $_("jobLanes.titleTypeset", { values: { page } });
			if (/^Review page \d+$/i.test(title)) return $_("jobLanes.titleReview", { values: { page } });
			return title
				.replace(/^Page\s+(\d+)\s*-\s*/i, $_("jobLanes.pagePrefix") + " $1: ")
				.replace(/\bReview imported dialogue\b/gi, $_("jobLanes.reviewImported"));
		}

	function laneLabel(lane: WorkspaceJobLane): string {
		// Switch on the stable task-type CODE (`lane.id`). workspace-dashboard.ts now
		// stamps the code onto `lane.label` instead of a Thai string, so the lane
		// label resolves from the code with no Thai value-matching.
		switch (lane.id) {
			case "clean":
				return $_("jobLanes.laneClean");
			case "typeset":
				return $_("jobLanes.laneTypeset");
			case "review":
				return $_("jobLanes.laneReview");
			case "translate":
				return $_("jobLanes.laneTranslate");
			default:
				return $_(`taskType.${lane.id}`);
		}
	}

	function laneDue(lane: WorkspaceJobLane): string {
		if (lane.overdueCount > 0) return $_("jobLanes.overdueCount", { values: { n: lane.overdueCount } });
		if (lane.nextDueAt) return $_("jobLanes.dueAt", { values: { day: formatWorkflowDueDay(lane.nextDueAt) } });
		return $_("jobLanes.openCount", { values: { n: lane.openCount } });
	}

	function laneButtonLabel(lane: WorkspaceJobLane): string {
		if (!lane.openCount) return $_("jobLanes.viewLane");
		if (lane.overdueCount > 0 || lane.urgentCount > 0) return $_("jobLanes.openUrgent");
		return $_("jobLanes.openLane");
	}

	function laneAssigneeLabel(assignee: string): string {
		const normalized = assignee.trim().replace(/^@/, "");
		const lower = normalized.toLowerCase();
		if (lower === "local-user") return $_("jobLanes.assigneeYou");
		if (lower === "solo") return soloAssigneeLabel;
		if (lower === "qa" || lower === "qc") return lower.toUpperCase();
		return formatAssigneeHandle(normalized);
	}

	function laneAssigneeSummary(lane: WorkspaceJobLane): string {
		return lane.assignees.length ? lane.assignees.map(laneAssigneeLabel).join(", ") : $_("jobLanes.assigneeUnset");
	}
</script>

<div class="job-lanes" aria-label={$_("jobLanes.regionLabel")}>
	{#if primaryLane}
		{#if primaryLane.openCount}
			<button
				type="button"
				class="job-lane primary"
				class:hot={primaryLane.overdueCount > 0 || primaryLane.urgentCount > 0}
				onclick={() => onOpenLane(primaryLane)}
			>
				<div class="job-main">
					<strong>{laneLabel(primaryLane)}</strong>
					<span>{laneAssigneeSummary(primaryLane)}</span>
				</div>
				<div class="job-next">
					<strong>{laneAction(primaryLane)}</strong>
					<span>{primaryLane.firstOpenPageIndex !== null ? $_("jobLanes.pageN", { values: { n: primaryLane.firstOpenPageIndex + 1 } }) : laneDue(primaryLane)}</span>
				</div>
				<div class="job-progress">
					<span>{primaryLane.doneCount}/{primaryLane.totalCount}</span>
					<small>{laneDue(primaryLane)}</small>
				</div>
				{#if primaryLane.urgentCount || primaryLane.overdueCount}
					<em>{primaryLane.overdueCount ? $_("jobLanes.overdueCount", { values: { n: primaryLane.overdueCount } }) : $_("jobLanes.urgentCount", { values: { n: primaryLane.urgentCount } })}</em>
				{/if}
				<span class="job-action">{laneButtonLabel(primaryLane)}</span>
			</button>
		{:else}
			<article class="job-lane primary idle" aria-label={$_("jobLanes.laneClearedAria", { values: { lane: laneLabel(primaryLane) } })}>
				<div class="job-main">
					<strong>{laneLabel(primaryLane)}</strong>
					<span>{laneAssigneeSummary(primaryLane)}</span>
				</div>
				<div class="job-next">
					<strong>{laneAction(primaryLane)}</strong>
					<span>{primaryLane.firstOpenPageIndex !== null ? $_("jobLanes.pageN", { values: { n: primaryLane.firstOpenPageIndex + 1 } }) : laneDue(primaryLane)}</span>
				</div>
				<div class="job-progress">
					<span>{primaryLane.doneCount}/{primaryLane.totalCount}</span>
					<small>{laneDue(primaryLane)}</small>
				</div>
				<span class="job-action ready">{laneButtonLabel(primaryLane)}</span>
			</article>
		{/if}
		{#if secondaryLanes.length}
			<details class="job-more">
				<summary>
					<span>{$_("jobLanes.otherLanes")}</span>
					<strong>{$_("jobLanes.laneCount", { values: { n: secondaryLanes.length } })}</strong>
				</summary>
				<div class="job-more-list">
					{#each secondaryLanes as lane (lane.id)}
						{#if lane.openCount}
							<button
								type="button"
								class="job-lane compact"
								class:hot={lane.overdueCount > 0 || lane.urgentCount > 0}
								onclick={() => onOpenLane(lane)}
							>
								<div class="job-main">
									<strong>{laneLabel(lane)}</strong>
									<span>{laneAssigneeSummary(lane)}</span>
								</div>
								<div class="job-next">
									<strong>{laneAction(lane)}</strong>
									<span>{lane.firstOpenPageIndex !== null ? $_("jobLanes.pageN", { values: { n: lane.firstOpenPageIndex + 1 } }) : laneDue(lane)}</span>
								</div>
								<div class="job-progress">
									<span>{lane.doneCount}/{lane.totalCount}</span>
									<small>{laneDue(lane)}</small>
								</div>
								{#if lane.urgentCount || lane.overdueCount}
									<em>{lane.overdueCount ? $_("jobLanes.overdueCount", { values: { n: lane.overdueCount } }) : $_("jobLanes.urgentCount", { values: { n: lane.urgentCount } })}</em>
								{/if}
								<span class="job-action">{laneButtonLabel(lane)}</span>
							</button>
						{:else}
							<article class="job-lane compact idle" aria-label={$_("jobLanes.laneClearedAria", { values: { lane: laneLabel(lane) } })}>
								<div class="job-main">
									<strong>{laneLabel(lane)}</strong>
									<span>{laneAssigneeSummary(lane)}</span>
								</div>
								<div class="job-next">
									<strong>{laneAction(lane)}</strong>
									<span>{lane.firstOpenPageIndex !== null ? $_("jobLanes.pageN", { values: { n: lane.firstOpenPageIndex + 1 } }) : laneDue(lane)}</span>
								</div>
								<div class="job-progress">
									<span>{lane.doneCount}/{lane.totalCount}</span>
									<small>{laneDue(lane)}</small>
								</div>
								<span class="job-action ready">{laneButtonLabel(lane)}</span>
							</article>
						{/if}
					{/each}
				</div>
			</details>
		{/if}
	{/if}
</div>

<style>
	.job-lanes {
		container-type: inline-size;
		display: grid;
		gap: 8px;
	}

	.job-lane {
		display: grid;
		grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.1fr) auto auto auto;
		align-items: center;
		gap: 10px;
		min-height: 58px;
		padding: 10px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-card, 12px);
		background: rgba(255, 255, 255, 0.025);
		color: inherit;
		cursor: pointer;
		font-family: inherit;
		text-align: left;
	}

	.job-lane.primary {
		border-color: rgba(124, 92, 255, 0.3);
		background: rgba(124, 92, 255, 0.08);
	}

	.job-lane:hover {
		border-color: rgba(124, 92, 255, 0.45);
		background: #1c1c26;
	}

	.job-lane.hot {
		border-color: rgba(251, 113, 133, 0.3);
	}

	.job-lane.idle {
		cursor: default;
		opacity: 0.56;
	}

	.job-lane.idle:hover {
		border-color: rgba(255, 255, 255, 0.075);
		background: rgba(255, 255, 255, 0.025);
	}

	.job-main,
	.job-next,
	.job-progress {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	.job-progress {
		text-align: right;
	}

	.job-lane strong {
		overflow: hidden;
		color: var(--color-ws-ink, #ececf2);
		font-size: 12px;
		font-weight: 800;
		text-overflow: ellipsis;
		overflow-wrap: anywhere;
		white-space: normal;
	}

	.job-lane span,
	.job-lane small {
		overflow: hidden;
		color: var(--color-ws-text, #9a9aa8);
		font-size: 10px;
		font-weight: 700;
		text-overflow: ellipsis;
		overflow-wrap: anywhere;
		white-space: normal;
	}

	.job-lane em {
		padding: 3px 6px;
		border: 1px solid rgba(251, 113, 133, 0.38);
		border-radius: 999px;
		color: var(--color-ws-rose, #fb7185);
		font-size: 10px;
		font-style: normal;
		font-weight: 800;
		white-space: nowrap;
	}

	.job-action {
		justify-self: end;
		padding: 7px 9px;
		border: 1px solid var(--ws-hair, rgba(255, 255, 255, 0.07));
		border-radius: var(--radius-ws-ctrl, 10px);
		background: rgba(255, 255, 255, 0.045);
		color: var(--color-ws-ink, #ececf2);
		font-size: 10px;
		font-weight: 800;
		white-space: nowrap;
	}

	.job-action.ready {
		border-color: rgba(52, 211, 153, 0.3);
		background: rgba(52, 211, 153, 0.12);
		color: var(--color-ws-green, #34d399);
	}

	.job-more {
		display: grid;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.025);
	}

	.job-more summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		min-height: 40px;
		padding: 0 10px;
		cursor: pointer;
		list-style: none;
	}

	.job-more summary::-webkit-details-marker {
		display: none;
	}

	.job-more:not([open]) > :not(summary) {
		display: none;
	}

	.job-more[open] {
		gap: 8px;
		padding-bottom: 10px;
	}

	.job-more-list {
		display: grid;
		width: calc(100% - 20px);
		gap: 8px;
		margin-inline: 10px;
	}

	.job-more summary span,
	.job-more summary strong {
		font-size: 11px;
		font-weight: 800;
	}

	.job-more summary span {
		color: #c4b5fd;
	}

	.job-more summary strong {
		color: var(--color-ws-ink, #ececf2);
	}

	/* Stack the lane into a single column on narrow containers (phone → narrow panel). */
	@container (max-width: 640px) {
		.job-lane {
			grid-template-columns: 1fr;
		}

		.job-progress {
			text-align: left;
		}

		.job-action {
			justify-self: start;
		}
	}

	/* Creator-studio lane queue skin (violet / magenta, dark hairline). */
	.job-lane,
	.job-more {
		border-color: rgba(255, 255, 255, 0.07);
		border-radius: 12px;
		background: #15151d;
		box-shadow: 0 1px 0 rgba(255, 255, 255, 0.02) inset, 0 14px 40px -28px rgba(0, 0, 0, 0.9);
	}

	.job-lane.primary {
		border-color: rgba(124, 92, 255, 0.3);
		background:
			linear-gradient(100deg, rgba(139, 92, 246, 0.16), rgba(217, 70, 239, 0.07)),
			#15151d;
	}

	.job-lane:hover {
		border-color: rgba(124, 92, 255, 0.4);
		background: #1c1c26;
	}

	.job-lane.hot {
		border-color: rgba(251, 113, 133, 0.32);
	}

	.job-lane strong,
	.job-more summary strong {
		color: #ececf2;
	}

	.job-lane span,
	.job-lane small,
	.job-more summary span {
		color: #9a9aa8;
	}

	.job-action {
		min-height: 40px;
		border-color: rgba(124, 92, 255, 0.3);
		border-radius: 10px;
		background: rgba(124, 92, 255, 0.12);
		color: #c4b5fd;
	}

	.job-lane em {
		border-color: rgba(251, 113, 133, 0.38);
		border-radius: 999px;
		color: #fb7185;
	}
</style>
