<script lang="ts">
	import { _ } from "$lib/i18n";
	import {
		groupChapterDashboardSignals,
		type ChapterDashboard,
		type ChapterDashboardLane,
		type ChapterDashboardLaneId,
	} from "$lib/project/chapter-dashboard.js";
	import { resolvePageStatusText } from "$lib/project/page-work-copy-i18n.js";
	import { formatWorkflowDueDay } from "$lib/project/task-due.js";
	import type { BatchExportGate } from "$lib/project/page-operations.js";
	import type { PageBatchSummary, PageWorkSummary } from "$lib/project/page-work-summary.js";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { canUseLeadView, effectiveTeamMode } from "$lib/stores/workspace-team-mode.ts";

	interface Props {
		dashboard: ChapterDashboard;
		currentPageSummary: PageWorkSummary | null;
		activeBatchSummary: PageBatchSummary;
		activeExportGate: BatchExportGate;
		batchExportTargetLabel: string;
		batchScopeLabel: string;
		onOpenLane: (laneId: ChapterDashboardLaneId) => void;
		onFilterLane: (laneId: ChapterDashboardLaneId) => void;
	}

	let {
		dashboard,
		currentPageSummary,
		activeBatchSummary,
		activeExportGate,
		batchExportTargetLabel,
		batchScopeLabel,
		onOpenLane,
		onFilterLane,
	}: Props = $props();

	const progressWidth = $derived(`${Math.min(100, Math.max(0, dashboard.exportReadyPercent))}%`);
	const groupedSignals = $derived(groupChapterDashboardSignals(dashboard.signals));

	function laneHint(lane: ChapterDashboardLane): string {
		if (lane.count <= 0) return $_("chapterDashboardPanel.noPages");
		return $_("chapterDashboardPanel.openLane", { values: { label: lane.firstPageLabel } });
	}

	function laneLabel(lane: ChapterDashboardLane): string {
		if (lane.id === "attention") return $_("chapterDashboardPanel.laneAttention");
		if (lane.id === "overdue") return $_("chapterDashboardPanel.laneOverdue");
		if (lane.id === "urgent") return $_("chapterDashboardPanel.laneUrgent");
		if (lane.id === "high") return $_("chapterDashboardPanel.laneHigh");
		return resolvePageStatusText(lane.label, $_, $_("pageWork.statusFallback"));
	}

	function batchLine(summary: PageBatchSummary, gate: BatchExportGate): string {
		if (!summary.pageCount) return $_("chapterDashboardPanel.noBatch");
		return $_("chapterDashboardPanel.batchReady", { values: { ready: gate.readyCount, total: gate.pageCount, target: batchExportTargetLabel } });
	}

	function currentDueLine(summary: PageWorkSummary | null): string {
		if (!summary?.nextDueAt) return "";
		return $_("chapterDashboardPanel.due", { values: { day: formatWorkflowDueDay(summary.nextDueAt) } });
	}

	// 2-mode view: lead = full lane/signal board; assigned = focused single-page card only.
	let teamMode = $derived(effectiveTeamMode());
	let isLead = $derived(teamMode === "lead");

	function setTeamMode(mode: "lead" | "assigned"): void {
		editorUiStore.setWorkspaceTeamMode(mode);
	}
</script>

<section class="chapter-dashboard ws-panel rounded-ws-card" class:assigned={!isLead} aria-label={$_("chapterDashboardPanel.overviewAria")}>
	<div class="dashboard-head">
		<div class="dashboard-title">
			<span>{$_("chapterDashboardPanel.overviewTitle")}</span>
			<strong>{$_("chapterDashboardPanel.readyExportPercent", { values: { percent: dashboard.exportReadyPercent } })}</strong>
		</div>
		<div class="dashboard-progress ws-track" aria-label={$_("chapterDashboardPanel.readyExportPercent", { values: { percent: dashboard.exportReadyPercent } })}>
			<span class="ws-fill ws-grad-primary" style={`width:${progressWidth};`}></span>
		</div>
	</div>

	<div class="mode-seg ws-panel-quiet rounded-ws-ctrl" role="tablist" aria-label={$_("chapterDashboardPanel.viewModeAria")}>
		{#if canUseLeadView()}
		<button type="button" role="tab" aria-selected={isLead} class="ws-seg" class:on={isLead} class:ws-seg-on={isLead} onclick={() => setTeamMode("lead")}>
			{$_("chapterDashboardPanel.teamLead")}
		</button>
		{/if}
		<button type="button" role="tab" aria-selected={!isLead} class="ws-seg" class:on={!isLead} class:ws-seg-on={!isLead} onclick={() => setTeamMode("assigned")}>
			{$_("chapterDashboardPanel.myWork")}
		</button>
	</div>

	{#if isLead}
	<div class="dashboard-kpis" aria-label={$_("chapterDashboardPanel.healthAria")}>
		<div class="kpi ws-panel-quiet rounded-ws-ctrl">
			<strong>{dashboard.totalPages}</strong>
			<span>{$_("chapterDashboardPanel.pages")}</span>
		</div>
		<div class="kpi ws-panel-quiet rounded-ws-ctrl">
			<strong>{dashboard.totalLayers}</strong>
			<span>{$_("chapterDashboardPanel.layers")}</span>
		</div>
		<div class="kpi attention ws-panel-quiet rounded-ws-ctrl">
			<strong>{dashboard.attentionCount}</strong>
			<span title={$_("chapterDashboardPanel.attentionTitle")}>{$_("chapterDashboardPanel.attention")}</span>
		</div>
		<div class="kpi ready ws-panel-quiet rounded-ws-ctrl">
			<strong>{dashboard.exportReadyCount}</strong>
			<span title={$_("chapterDashboardPanel.readyTitle")}>{$_("chapterDashboardPanel.ready")}</span>
		</div>
	</div>

	<div class="lane-grid" aria-label={$_("chapterDashboardPanel.lanesAria")}>
		{#each dashboard.lanes as lane (lane.id)}
			<div class={`lane-card ws-panel-quiet rounded-ws-ctrl ${lane.tone}`} class:primary={lane.id === dashboard.primaryLane.id && lane.count > 0}>
				{#if lane.count > 0}
					<button
						type="button"
						class="lane-open"
						onclick={() => onOpenLane(lane.id)}
						aria-label={$_("chapterDashboardPanel.openLaneAria", { values: { label: laneLabel(lane) } })}
						title={laneHint(lane)}
					>
						<span>{laneLabel(lane)}</span>
						<strong>{lane.count}</strong>
					</button>
					<button
						type="button"
						class="lane-filter"
						onclick={() => onFilterLane(lane.id)}
						aria-label={$_("chapterDashboardPanel.filterLaneAria", { values: { label: laneLabel(lane) } })}
						title={$_("chapterDashboardPanel.filterLaneTitle", { values: { label: laneLabel(lane) } })}
					>
						{lane.firstPageLabel}
					</button>
				{:else}
					<span class="lane-open lane-receipt" aria-label={$_("chapterDashboardPanel.laneNoWorkAria", { values: { label: laneLabel(lane) } })}>
						<span>{laneLabel(lane)}</span>
						<strong>{lane.count}</strong>
					</span>
					<span class="lane-filter lane-receipt" aria-label={$_("chapterDashboardPanel.laneNoPagesAria", { values: { label: laneLabel(lane) } })}>-</span>
				{/if}
			</div>
		{/each}
	</div>

	<div class="signal-row" aria-label={$_("chapterDashboardPanel.signalsAria")}>
		<!-- Assets Group -->
		<div class="signal-group">
			<span class="group-label">Assets</span>
			<div class="group-items">
				<span class:hot={groupedSignals.assets.assetBlocked > 0}>{$_("chapterDashboardPanel.assetBlocked", { values: { n: groupedSignals.assets.assetBlocked } })}</span>
				<span class:hot={groupedSignals.assets.assetScanning > 0}>{$_("chapterDashboardPanel.assetScanning", { values: { n: groupedSignals.assets.assetScanning } })}</span>
			</div>
		</div>

		<!-- QC Group -->
		<div class="signal-group">
			<span class="group-label">QC</span>
			<div class="group-items">
				<span class:hot={groupedSignals.qc.qcErrors > 0}>{$_("chapterDashboardPanel.qcErrors", { values: { n: groupedSignals.qc.qcErrors } })}</span>
				<span class:hot={groupedSignals.qc.qcWarnings > 0}>{$_("chapterDashboardPanel.qcWarnings", { values: { n: groupedSignals.qc.qcWarnings } })}</span>
			</div>
		</div>

		<!-- AI & Comments Group -->
		<div class="signal-group">
			<span class="group-label">AI & Comments</span>
			<div class="group-items">
				<span class:hot={groupedSignals.aiComments.aiAttention > 0}>{$_("chapterDashboardPanel.aiAttention", { values: { n: groupedSignals.aiComments.aiAttention } })}</span>
				<span class:hot={groupedSignals.aiComments.openComments > 0}>{$_("chapterDashboardPanel.openComments", { values: { n: groupedSignals.aiComments.openComments } })}</span>
			</div>
		</div>

		<!-- Tasks Group -->
		<div class="signal-group">
			<span class="group-label">Tasks</span>
			<div class="group-items">
				<span class:hot={groupedSignals.tasks.overdueTasks > 0}>{$_("chapterDashboardPanel.overdueTasks", { values: { n: groupedSignals.tasks.overdueTasks } })}</span>
				<span class:hot={groupedSignals.tasks.dueTasks > 0}>{$_("chapterDashboardPanel.dueTasks", { values: { n: groupedSignals.tasks.dueTasks } })}</span>
				<span class:hot={groupedSignals.tasks.urgentTasks > 0}>{$_("chapterDashboardPanel.urgentTasks", { values: { n: groupedSignals.tasks.urgentTasks } })}</span>
				<span class:hot={groupedSignals.tasks.highTasks > 0}>{$_("chapterDashboardPanel.highTasks", { values: { n: groupedSignals.tasks.highTasks } })}</span>
				<span class:hot={groupedSignals.tasks.openTasks > 0}>{$_("chapterDashboardPanel.openTasks", { values: { n: groupedSignals.tasks.openTasks } })}</span>
			</div>
		</div>

		<!-- People Group -->
		<div class="signal-group">
			<span class="group-label">People</span>
			<div class="group-items">
				<span>{$_("chapterDashboardPanel.assignees", { values: { n: groupedSignals.people.assignees } })}</span>
			</div>
		</div>
	</div>
	{/if}

	<div class={`current-page-work ${currentPageSummary?.status ?? "empty"}`}>
		<div class="current-work-main">
			<span class="work-label">{isLead ? $_("chapterDashboardPanel.currentPage") : $_("chapterDashboardPanel.myWorkCurrentPage")}</span>
			<strong>{resolvePageStatusText(currentPageSummary?.statusLabel, $_, $_("pageWork.statusFallback"))}</strong>
		</div>
		<div class="current-work-meta">
			<span>{$_("chapterDashboardPanel.layersCount", { values: { n: currentPageSummary?.layerCount ?? 0 } })}</span>
			{#if currentPageSummary && currentPageSummary.highestTaskPriority !== "normal"}
				<span class={`priority-${currentPageSummary.highestTaskPriority}`}>
					{currentPageSummary.priorityLabel}
				</span>
			{/if}
			{#if currentPageSummary?.overdueTaskCount}
				<span class="due-overdue">{$_("chapterDashboardPanel.overdueCount", { values: { n: currentPageSummary.overdueTaskCount } })}</span>
			{:else if currentDueLine(currentPageSummary)}
				<span>{currentDueLine(currentPageSummary)}</span>
			{/if}
			<span>{batchScopeLabel}</span>
			<span class:exportReady={activeExportGate.canExport && activeExportGate.pageCount > 0}>
				{batchLine(activeBatchSummary, activeExportGate)}
			</span>
		</div>
	</div>
</section>

<style>
	.chapter-dashboard {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px;
		font-variant-numeric: tabular-nums;
		font-feature-settings: "tnum" 1;
	}

	.dashboard-head {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 6px;
	}

	/* Use the shared segmented-control tokens so this compact dashboard matches the workspace shell. */
	.mode-seg {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 4px;
		padding: 3px;
	}

	.mode-seg button {
		min-height: 36px;
		padding: 4px 6px;
		border: 1px solid transparent;
		border-radius: var(--radius-ws-ctrl);
		background: transparent;
		cursor: pointer;
		font-family: inherit;
		font-size: 10px;
		font-weight: 800;
		transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
	}

	.mode-seg button:hover {
		color: var(--color-ws-ink);
	}

	.mode-seg button.on {
		border-color: color-mix(in srgb, var(--color-ws-accent) 34%, transparent);
		background: color-mix(in srgb, var(--color-ws-accent) 22%, transparent);
		color: var(--color-ws-ink);
	}

	.dashboard-title {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		min-width: 0;
	}

	.dashboard-title span,
	.work-label {
		color: var(--color-ws-text);
		font-size: 9px;
		font-weight: 850;
		letter-spacing: 0;
		text-transform: uppercase;
	}

	.dashboard-title strong {
		overflow: hidden;
		color: var(--color-ws-ink);
		font-size: 12px;
		line-height: 1.2;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.dashboard-progress {
		width: 100%;
		height: 7px;
	}

	.dashboard-progress span {
		display: block;
		height: 100%;
	}

	.dashboard-kpis {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 5px;
	}

	.kpi {
		display: flex;
		min-width: 0;
		min-height: 42px;
		flex-direction: column;
		justify-content: center;
		gap: 2px;
		padding: 6px;
	}

	.kpi strong {
		color: var(--color-ws-ink);
		font-size: 15px;
		line-height: 1.2;
	}

	.kpi span {
		overflow: hidden;
		color: var(--color-ws-text);
		font-size: 9px;
		font-weight: 700;
		text-overflow: ellipsis;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.kpi.attention strong {
		color: var(--color-ws-amber);
	}

	.kpi.ready strong {
		color: var(--color-ws-green);
	}

	.lane-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 4px;
	}

	.lane-card {
		display: grid;
		grid-template-rows: minmax(42px, auto) minmax(40px, auto);
		min-width: 0;
		overflow: hidden;
	}

	.lane-card.primary {
		border-color: color-mix(in srgb, var(--color-ws-accent) 50%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-ws-accent) 24%, transparent);
	}

	.lane-open,
	.lane-filter {
		min-width: 0;
		border: 0;
		background: transparent;
		color: var(--color-ws-text);
		cursor: pointer;
		font-family: inherit;
	}

	.lane-open {
		display: flex;
		min-height: 42px;
		flex-direction: column;
		justify-content: center;
		gap: 1px;
		padding: 4px;
		text-align: left;
	}

	.lane-open span,
	.lane-filter {
		overflow: hidden;
		font-size: 9px;
		font-weight: 800;
		line-height: 1.15;
		text-overflow: ellipsis;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.lane-open strong {
		color: var(--color-ws-ink);
		font-size: 13px;
		line-height: 1.2;
	}

	.lane-filter {
		min-height: 40px;
		border-top: 1px solid var(--ws-hair);
		background: color-mix(in srgb, var(--color-ws-surface2) 46%, transparent);
	}

	.lane-receipt {
		cursor: default;
		opacity: 0.38;
	}

	.lane-card.blocked .lane-open strong,
	.lane-card.urgent .lane-open strong {
		color: var(--color-ws-rose);
	}

	.lane-card.review .lane-open strong,
	.lane-card.high .lane-open strong,
	.lane-card.attention .lane-open strong {
		color: var(--color-ws-amber);
	}

	.lane-card.ready .lane-open strong {
		color: var(--color-ws-green);
	}

	.lane-card.empty .lane-open strong {
		color: var(--color-ws-violet);
	}

	.signal-row {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.signal-group {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 6px 8px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 34%, transparent);
	}

	.group-label {
		font-size: 8px;
		font-weight: 900;
		color: var(--color-ws-faint);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.group-items {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.group-items span {
		min-height: 18px;
		padding: 3px 6px;
		border: 1px solid var(--ws-hair-strong);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 48%, transparent);
		color: var(--color-ws-text);
		font-size: 9px;
		font-weight: 850;
		line-height: 1.15;
		overflow: hidden;
		text-overflow: ellipsis;
		text-transform: uppercase;
		white-space: nowrap;
		transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
	}

	.group-items span:hover {
		border-color: color-mix(in srgb, var(--color-ws-line) 18%, transparent);
		background: color-mix(in srgb, var(--color-ws-surface2) 72%, transparent);
	}

	.group-items .hot {
		color: var(--color-ws-rose);
		border-color: color-mix(in srgb, var(--color-ws-rose) 40%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 8%, transparent);
	}

	.group-items .hot:hover {
		border-color: color-mix(in srgb, var(--color-ws-rose) 60%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 14%, transparent);
	}

	.current-page-work {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(76px, auto);
		align-items: center;
		gap: 8px;
		min-height: 48px;
		padding: 7px 8px;
		border: 1px solid var(--ws-hair);
		border-radius: var(--radius-ws-ctrl);
		background: color-mix(in srgb, var(--color-ws-surface2) 55%, transparent);
	}

	.current-page-work.blocked {
		border-color: color-mix(in srgb, var(--color-ws-rose) 46%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 10%, transparent);
	}

	.current-page-work.review {
		border-color: color-mix(in srgb, var(--color-ws-amber) 36%, transparent);
		background: color-mix(in srgb, var(--color-ws-amber) 8%, transparent);
	}

	.current-page-work.ready {
		border-color: color-mix(in srgb, var(--color-ws-green) 32%, transparent);
		background: color-mix(in srgb, var(--color-ws-green) 7%, transparent);
	}

	/* assigned mode: the panel collapses to the single focused-page card */
	.chapter-dashboard.assigned .current-page-work {
		border-color: color-mix(in srgb, var(--color-ws-green) 28%, transparent);
	}

	.current-work-main {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.current-work-main strong {
		color: var(--color-ws-ink);
		font-size: 12px;
		line-height: 1.2;
	}

	.current-work-meta {
		display: flex;
		min-width: 76px;
		flex-direction: column;
		align-items: flex-end;
		gap: 3px;
		color: var(--color-ws-text);
		font-size: 10px;
		font-weight: 750;
		white-space: nowrap;
	}

	.current-work-meta span {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.current-work-meta .exportReady {
		color: var(--color-ws-green);
	}

	.current-work-meta .priority-urgent {
		color: var(--color-ws-rose);
	}

	.current-work-meta .due-overdue {
		color: var(--color-ws-rose);
	}

	.current-work-meta .priority-high {
		color: var(--color-ws-amber);
	}
</style>
