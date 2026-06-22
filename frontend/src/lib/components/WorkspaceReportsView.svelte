<!-- WorkspaceReportsView — the workspace REPORTS surface.

	A read-only, production-facing roll-up of data the workspace already records:
	pipeline throughput, AI-credit + storage usage, anonymized team performance +
	ROI, the open chapter's export-readiness, a library-wide project roll-up, and
	recent export-run history. An optional revenue panel renders ONLY when the
	signed-in account holds the admin revenue permission (admin:revenue.read).

	Every figure is honest: it is read from existing pure builders / stores. When a
	source has no data the relevant panel shows a genuine empty / loading / error
	state — never fabricated numbers or invented trends. This view is self-gated on
	editorUiStore.workspaceView === "reports", matching the other workspace surfaces
	(WorkspaceDashboard / WorkspaceMembersSettings) that all mount inside the shell. -->
<script lang="ts">
	import { onMount } from "svelte";
	import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
	import { projectStore } from "$lib/stores/project.svelte.ts";
	import { authStore, rolePermissionProfile } from "$lib/stores/auth.svelte.ts";
	import { _ } from "$lib/i18n";
	import { safeT } from "$lib/i18n/safeLocale";
	import { usageStore, formatBytes, thbToCredits, formatCreditsCompact } from "$lib/stores/usage.svelte.ts";
	import { perfAnalyticsStore } from "$lib/stores/perf-analytics.svelte.ts";
	import {
		buildPipelineThroughputRows,
		buildPipelineStageCountRows,
		buildUsageTrend,
		buildStorageBreakdownRows,
		buildPerfAnalytics,
		pipelineHasAnyData,
		finiteNonNegative,
		type PipelineStageInput,
	} from "$lib/project/workspace-analytics.ts";
	import { buildWorkspaceJobLanes } from "$lib/project/workspace-dashboard.ts";
	import { buildChapterDashboard } from "$lib/project/chapter-dashboard.ts";
	import { summarizePageBatch, summarizePageWork, type PageWorkSummary } from "$lib/project/page-work-summary.ts";
	import {
		getVisibleExportHistoryRuns,
		formatExportRunMessage,
		formatExportRunPages,
		formatExportRunSize,
	} from "$lib/project/export-runs.ts";
	import { setAdminApiToken, getAdminMe } from "$lib/api/admin.ts";
	import { adminRevenueApi, type RevenueSummary } from "$lib/api/admin/revenue.ts";
	import SectionBand from "$lib/components/ui/SectionBand.svelte";
	import WorkspacePageHeader from "$lib/components/ui/WorkspacePageHeader.svelte";
	import WorkspaceTopUtilityBar from "$lib/components/WorkspaceTopUtilityBar.svelte";
	import StatTile from "$lib/components/ui/StatTile.svelte";
	import BarChart from "$lib/components/ui/BarChart.svelte";
	import Sparkline from "$lib/components/ui/Sparkline.svelte";
	import ProgressBar from "$lib/components/ui/ProgressBar.svelte";
	import StatTrend from "$lib/components/ui/StatTrend.svelte";
	import NumberValue from "$lib/components/ui/NumberValue.svelte";

	const REVENUE_READ = "admin:revenue.read";

	// Platform back-office roles are the ONLY accounts that could hold an
	// admin:* permission (the real authorization is computed server-side and
	// delivered via GET /api/admin/me). Ordinary studio accounts — editor /
	// viewer, and workspace owners (whose platform role is editor/viewer) — never
	// do, so calling getAdminMe() for them just yields a 403 in the console on
	// every page (WorkspaceReportsView mounts inside WorkspaceShell everywhere).
	// Gate the probe on the client-known platform role so normal users never hit
	// the admin endpoint; genuine back-office accounts still get the revenue panel.
	const PLATFORM_ADMIN_ROLES = new Set(["owner", "admin", "support", "accountant"]);

	// Localised production-stage labels. These previously rendered Thai-only
	// regardless of locale — so the EN/JA/KO/ZH/AR Reports page showed Thai in the
	// throughput + stage-count charts. Resolve them through the shared dashboard.stage*
	// keys (same labels as the dashboard pipeline) so the charts read in the viewer's
	// language. `$_` keeps them reactive to locale; the keys are guaranteed present in
	// every locale by the i18n parity guard, so no Thai fallback is needed.
	const PIPELINE_STAGE_LABEL_KEYS: Record<string, string> = {
		clean: "dashboard.stageClean",
		translate: "dashboard.stageTranslate",
		typeset: "dashboard.stageTypeset",
		review: "reports.stageReview",
	};

	function pipelineStageLabel(stageId: string): string {
		const key = PIPELINE_STAGE_LABEL_KEYS[stageId];
		return key ? $_(key) : stageId;
	}

	let isActive = $derived(editorUiStore.workspaceView === "reports");
	let hasProject = $derived(Boolean(projectStore.project));

	// ── Pipeline throughput (real, from the OPEN chapter's job lanes) ──
	let roleCapabilities = $derived(
		rolePermissionProfile(projectStore.currentWorkspaceMember?.memberStudioRole ?? authStore.role),
	);
	let jobLanes = $derived(buildWorkspaceJobLanes(projectStore.tasks, roleCapabilities));
	let pipelineStages = $derived<PipelineStageInput[]>(
		hasProject && jobLanes.length > 0
			? ["clean", "translate", "typeset", "review"]
					.map((id) => jobLanes.find((lane) => lane.id === id))
					.filter((lane): lane is (typeof jobLanes)[number] => Boolean(lane))
					.map((lane) => ({
						id: lane.id,
						labelTh: pipelineStageLabel(lane.id),
						doneCount: lane.doneCount,
						totalCount: lane.totalCount,
						openCount: lane.openCount,
					}))
			: ["clean", "translate", "typeset", "review"].map((id) => ({
					id,
					labelTh: pipelineStageLabel(id),
					doneCount: 0,
					totalCount: 0,
					openCount: 0,
				})),
	);
	let throughputRows = $derived(buildPipelineThroughputRows(pipelineStages));
	let stageCountRows = $derived(buildPipelineStageCountRows(pipelineStages));
	let pipelineLive = $derived(hasProject && pipelineHasAnyData(pipelineStages));
	let totalPagesDone = $derived(throughputRows.reduce((sum, row) => sum + row.doneCount, 0));
	let totalPagesRouted = $derived(throughputRows.reduce((sum, row) => sum + row.totalCount, 0));
	let totalOpen = $derived(stageCountRows.reduce((sum, row) => sum + row.value, 0));

	// ── Usage (real: today vs this-month windows + storage snapshot) ──
	let usageTrend = $derived(buildUsageTrend(usageStore.dashboard));
	let storageRows = $derived(buildStorageBreakdownRows(usageStore.dashboard));
	let storagePct = $derived(usageStore.storagePct);
	let aiPct = $derived(Math.min(100, usageStore.aiPct));

	// ── Team performance (real anonymized aggregate + ROI) ──
	let perf = $derived(buildPerfAnalytics(perfAnalyticsStore.aggregate));

	// ── Current chapter export-readiness (real, from the open project's pages) ──
	// Mirrors WorkspaceDashboard.buildPageSummaries: feed summarizePageWork the same
	// read-only project getters (tasks / comments / markers / decisions / QC / asset
	// integrity). All inputs are existing public store state — no new project fields.
	let pageSummaries = $derived<PageWorkSummary[]>(
		(projectStore.project?.pages ?? []).map((page, pageIndex) =>
			summarizePageWork({
				page,
				pageIndex,
				assetIntegrity: projectStore.getPageAssetIntegrity(pageIndex),
				qcIssues: projectStore.qcReport.issues,
				tasks: projectStore.tasks,
				comments: projectStore.comments,
				aiReviewMarkers: projectStore.aiReviewMarkers,
				reviewDecisions: projectStore.reviewDecisions,
				productionMode: projectStore.project?.productionMode ?? "solo",
			}),
		),
	);
	let chapterBatchSummary = $derived(summarizePageBatch(pageSummaries));
	let chapterDashboard = $derived(buildChapterDashboard(pageSummaries, chapterBatchSummary));

	// ── Library roll-up (real, from the recent-projects summaries the store loads) ──
	let recent = $derived(projectStore.recentProjects);
	let libraryStats = $derived(
		recent.reduce(
			(acc, project) => ({
				pages: acc.pages + finiteNonNegative(project.pageCount),
				openTasks: acc.openTasks + finiteNonNegative(project.openTaskCount),
				openComments: acc.openComments + finiteNonNegative(project.openCommentCount),
			}),
			{ pages: 0, openTasks: 0, openComments: 0 },
		),
	);
	let hasLibrary = $derived(recent.length > 0);

	// ── Export run history (real, from the open project's recorded runs) ──
	let exportRuns = $derived(getVisibleExportHistoryRuns(projectStore.exportRuns));

	// ── Revenue (gated: only when the viewer holds the revenue permission) ──
	let revenueState = $state<"idle" | "loading" | "denied" | "ready" | "error">("idle");
	let revenueSummary = $state<RevenueSummary | null>(null);
	let revenueError = $state<string | null>(null);

	async function loadRevenueIfPermitted(): Promise<void> {
		// Skip the admin probe entirely for ordinary accounts. Only platform
		// back-office roles can hold admin:revenue.read; firing getAdminMe() for an
		// editor/viewer (or a workspace owner, whose platform role is editor/viewer)
		// just logs a 403 on every page. The server stays the source of truth — a
		// platform-admin role still goes through getAdminMe() below for the real
		// per-permission gate.
		if (!authStore.role || !PLATFORM_ADMIN_ROLES.has(authStore.role)) {
			revenueState = "denied";
			return;
		}
		// The admin surface is Bearer-authenticated against the shared admin client.
		// Mirror the /admin layout: seed the token from the live session before any
		// admin call so getAdminMe / revenue queries carry authorization.
		const token = authStore.accessToken;
		if (!token) {
			revenueState = "denied";
			return;
		}
		setAdminApiToken(token);
		revenueState = "loading";
		revenueError = null;
		try {
			const me = await getAdminMe();
			if (!me.permissions.includes(REVENUE_READ)) {
				// No revenue permission → omit the panel entirely (honest, not an error).
				revenueState = "denied";
				return;
			}
			const summary = await adminRevenueApi.getSummary();
			revenueSummary = summary;
			revenueState = "ready";
		} catch (cause) {
			revenueState = "error";
			revenueError = cause instanceof Error ? cause.message : safeT("reports.revenueLoadFailed", "โหลดข้อมูลรายได้ไม่สำเร็จ");
		}
	}

	function formatCents(cents: string): string {
		const value = Number(cents);
		if (!Number.isFinite(value)) return "—";
		return (value / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
	}

	// The "throughput, readiness, performance, history" panels are all derived from
	// an OPEN chapter / library work, so with a fresh workspace they every one fall
	// back to a "no data" placeholder — the audit saw a wall of stacked empties.
	// When there is genuinely no work yet (no library, no pipeline, no open-chapter
	// readiness, no team performance, no export history, and no revenue panel) we
	// collapse those placeholders into ONE clean premium empty-state card. The
	// usage panel is kept because it always reflects REAL (even if zero) workspace
	// usage, not a placeholder. The moment any work source has data, the full
	// per-section report takes over again.
	let chapterReadinessLive = $derived(hasProject && chapterDashboard.totalPages > 0);
	let revenuePanelVisible = $derived(revenueState === "ready" || revenueState === "error");
	let reportsAllEmpty = $derived(
		!hasLibrary
			&& !pipelineLive
			&& !chapterReadinessLive
			&& !perf.hasData
			&& exportRuns.length === 0
			&& !revenuePanelVisible,
	);

	onMount(() => {
		void loadRevenueIfPermitted();
	});
</script>

{#if isActive}
	<section class="ws-surface workspace-reports" aria-label={$_("reports.surfaceAria")}>
		<div class="ws-surface-inner">
		<WorkspaceTopUtilityBar />
		<WorkspacePageHeader
			eyebrow={$_("reports.eyebrow")}
			title={$_("reports.title")}
			subtitle={$_("reports.subtitle")}
		>
			{#snippet actions()}
				<span class="reports-badge ws-grad-primary-soft">{$_("reports.realDataBadge")}</span>
			{/snippet}
		</WorkspacePageHeader>

		{#if reportsAllEmpty}
		<!-- CONSOLIDATED EMPTY STATE — one clean premium card instead of six
			stacked "no data" placeholders, shown only when every source is empty. -->
		<div class="reports-empty-hero ws-panel" data-testid="reports-empty-hero">
			<div class="reports-empty-hero-icon ws-panel-quiet" aria-hidden="true">
				<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
					<path d="M3 3v18h18" />
					<rect x="7" y="12" width="3" height="6" rx="1" />
					<rect x="12" y="8" width="3" height="10" rx="1" />
					<rect x="17" y="5" width="3" height="13" rx="1" />
				</svg>
			</div>
			<h3 class="reports-empty-hero-title">{$_("reports.emptyHeroTitle")}</h3>
			<p class="reports-empty-hero-detail">
				{$_("reports.emptyHeroDetail")}
			</p>
		</div>

		<!-- Usage still reflects REAL (zero) workspace usage even with no work yet,
			so keep it visible alongside the consolidated empty hero. -->
		{#if usageTrend.hasData}
			<SectionBand title={$_("reports.usageTitle")} subtitle={$_("reports.usageCompanionSubtitle")} class="mt-6" />
			<div class="ws-panel rounded-ws-card p-[clamp(16px,1.8vw,20px)]" data-testid="reports-usage-empty-companion">
				<div class="grid grid-cols-2 gap-3 mb-4">
					<StatTrend
						label={$_("reports.usageAiToday")}
						value={thbToCredits(usageTrend.daily.aiCommittedThb)}
						previous={thbToCredits(usageTrend.monthly.aiCommittedThb)}
						suffix={` ${$_("credits.unit")}`}
						tone="violet"
						higherIsBetter={false}
						series={usageTrend.aiSeries.map((v) => thbToCredits(v))}
						caption={`${$_("reports.usageThisMonth")} ${formatCreditsCompact(thbToCredits(usageTrend.monthly.aiCommittedThb))}${usageTrend.monthly.aiLimitThb > 0 ? ` / ${formatCreditsCompact(thbToCredits(usageTrend.monthly.aiLimitThb))}` : ""} · ${aiPct.toFixed(0)}%`}
					/>
					<StatTrend
						label={$_("reports.usageStorageUsed")}
						value={usageTrend.monthly.storageUsedBytes}
						prefix=""
						compact={true}
						tone="violet"
						higherIsBetter={false}
						caption={`${formatBytes(usageTrend.monthly.storageUsedBytes)}${usageTrend.monthly.storageLimitBytes > 0 ? ` / ${formatBytes(usageTrend.monthly.storageLimitBytes)}` : ""} · ${storagePct.toFixed(0)}%`}
					/>
				</div>
				<div class="border-t border-ws-line/[0.07] pt-3.5">
					<p class="text-[11px] text-ws-faint mb-2">{$_("reports.usageStorageBreakdown")}</p>
					<BarChart rows={storageRows} valueSuffix="" emptyLabel={$_("reports.usageStorageEmpty")} />
				</div>
			</div>
		{/if}
		{:else}

		<!-- LIBRARY ROLL-UP -->
		<SectionBand title="library" subtitle={$_("reports.sectionLibrary")} />
		{#if hasLibrary}
			<div class="reports-stat-grid" data-testid="reports-library-stats">
				<StatTile label={$_("reports.libraryChapters")} value={recent.length} tone="violet" />
				<StatTile label={$_("reports.libraryPages")} value={libraryStats.pages} tone="cyan" />
				<StatTile label={$_("reports.libraryOpenTasks")} value={libraryStats.openTasks} tone="amber" />
				<StatTile label={$_("reports.libraryOpenComments")} value={libraryStats.openComments} tone="rose" />
			</div>
		{:else}
			<div class="reports-empty" data-testid="reports-library-empty">
				<p class="reports-empty-title">{$_("reports.libraryEmptyTitle")}</p>
				<p>{$_("reports.libraryEmptyDetail")}</p>
			</div>
		{/if}

		<!-- PIPELINE + USAGE -->
		<SectionBand title="throughput & usage" subtitle={$_("reports.sectionThroughputUsage")} class="mt-6" />
		<div class="grid gap-6 ws-two-col">
			<!-- Pipeline throughput (open chapter) -->
			<div class="ws-panel rounded-ws-card p-[clamp(16px,1.8vw,20px)]" data-testid="reports-pipeline">
				<div class="flex items-center justify-between gap-2 mb-3.5 flex-wrap">
					<h3 class="text-[14px] font-semibold text-ws-ink">{$_("reports.pipelineTitle")} <span class="text-ws-faint font-normal text-[12px] ml-1">· pipeline</span></h3>
					{#if pipelineLive}
						<span class="ws-num text-[11px] text-ws-faint">
							{$_("reports.pipelineDone", { values: { done: totalPagesDone, total: totalPagesRouted } })}
						</span>
					{/if}
				</div>
				{#if pipelineLive}
					<p class="text-[11px] text-ws-faint mb-1.5">{$_("reports.pipelineDoneCaption")}</p>
					<BarChart rows={throughputRows} class="mb-4" />
					<div class="border-t border-ws-line/[0.07] pt-3.5">
						<div class="flex items-center justify-between gap-2 mb-1.5">
							<p class="text-[11px] text-ws-faint">{$_("reports.pipelineOpenCaption")}</p>
							<span class="ws-num text-[11px] text-ws-faint">{$_("reports.pipelineOpen", { values: { count: totalOpen } })}</span>
						</div>
						<BarChart rows={stageCountRows} valueSuffix={$_("reports.pipelineTasksUnit")} />
					</div>
				{:else}
					<div class="reports-empty">
						<p class="reports-empty-title">{hasProject ? $_("reports.pipelineEmptyHasProject") : $_("reports.pipelineEmptyNoProject")}</p>
						<p>{$_("reports.pipelineEmptyDetail")}</p>
					</div>
				{/if}
			</div>

			<!-- Usage trend (AI credits + storage) -->
			<div class="ws-panel rounded-ws-card p-[clamp(16px,1.8vw,20px)]" data-testid="reports-usage">
				<div class="flex items-center justify-between gap-2 mb-3.5 flex-wrap">
					<h3 class="text-[14px] font-semibold text-ws-ink">{$_("reports.usageTitle")} <span class="text-ws-faint font-normal text-[12px] ml-1">· usage</span></h3>
				</div>
				{#if usageTrend.hasData}
					<div class="grid grid-cols-2 gap-3 mb-4">
						<StatTrend
							label={$_("reports.usageAiToday")}
							value={thbToCredits(usageTrend.daily.aiCommittedThb)}
							previous={thbToCredits(usageTrend.monthly.aiCommittedThb)}
							suffix={` ${$_("credits.unit")}`}
							tone="cyan"
							higherIsBetter={false}
							series={usageTrend.aiSeries.map((v) => thbToCredits(v))}
							caption={`${$_("reports.usageThisMonth")} ${formatCreditsCompact(thbToCredits(usageTrend.monthly.aiCommittedThb))}${usageTrend.monthly.aiLimitThb > 0 ? ` / ${formatCreditsCompact(thbToCredits(usageTrend.monthly.aiLimitThb))}` : ""} · ${aiPct.toFixed(0)}%`}
						/>
						<StatTrend
							label={$_("reports.usageStorageUsed")}
							value={usageTrend.monthly.storageUsedBytes}
							prefix=""
							compact={true}
							tone="violet"
							higherIsBetter={false}
							caption={`${formatBytes(usageTrend.monthly.storageUsedBytes)}${usageTrend.monthly.storageLimitBytes > 0 ? ` / ${formatBytes(usageTrend.monthly.storageLimitBytes)}` : ""} · ${storagePct.toFixed(0)}%`}
						/>
					</div>
					<div class="border-t border-ws-line/[0.07] pt-3.5">
						<p class="text-[11px] text-ws-faint mb-2">{$_("reports.usageStorageBreakdown")}</p>
						<BarChart rows={storageRows} valueSuffix="" emptyLabel={$_("reports.usageStorageEmpty")} />
					</div>
				{:else}
					<div class="reports-empty">
						<p class="reports-empty-title">{$_("reports.usageEmptyTitle")}</p>
						<p>{$_("reports.usageEmptyDetail")}</p>
					</div>
				{/if}
			</div>
		</div>

		<!-- CHAPTER EXPORT-READINESS -->
		<SectionBand title="export readiness" subtitle={$_("reports.sectionExportReadiness")} class="mt-6" />
		<div class="ws-panel rounded-ws-card p-[clamp(16px,1.8vw,20px)]" data-testid="reports-export-ready">
			{#if hasProject && chapterDashboard.totalPages > 0}
				<div class="flex items-center justify-between gap-3 mb-3 flex-wrap">
					<h3 class="text-[14px] font-semibold text-ws-ink">{$_("reports.exportReadyTitle")}</h3>
					<span class="ws-num text-[12px] text-ws-faint">
						<NumberValue value={chapterDashboard.exportReadyCount} class="text-ws-ink font-semibold" />/<NumberValue value={chapterDashboard.totalPages} class="text-ws-ink font-semibold" /> {$_("reports.exportReadyTotalPages")} · {chapterDashboard.exportReadyPercent}%
					</span>
				</div>
				<ProgressBar value={chapterDashboard.exportReadyPercent} tone={chapterDashboard.exportReadyPercent >= 100 ? "green" : "accent"} showLabel ariaLabel={$_("reports.exportReadyAria")} />
				<div class="reports-stat-grid mt-4">
					<StatTile label={$_("reports.exportReadyTotalPages")} value={chapterDashboard.totalPages} tone="violet" />
					<StatTile label={$_("reports.exportReadyLayers")} value={chapterDashboard.totalLayers} tone="cyan" />
					<StatTile label={$_("reports.exportReadyAttention")} value={chapterDashboard.attentionCount} tone="amber" />
					<StatTile label={$_("reports.exportReadyOpenComments")} value={chapterDashboard.signals.openComments} tone="rose" />
				</div>
			{:else}
				<div class="reports-empty">
					<p class="reports-empty-title">{hasProject ? $_("reports.exportReadyEmptyHasProject") : $_("reports.exportReadyEmptyNoProject")}</p>
					<p>{$_("reports.exportReadyEmptyDetail")}</p>
				</div>
			{/if}
		</div>

		<!-- TEAM PERFORMANCE + ROI -->
		<SectionBand title="team performance" subtitle={$_("reports.sectionTeamPerformance")} class="mt-6" />
		<div class="ws-panel rounded-ws-card p-[clamp(16px,1.8vw,20px)]" data-testid="reports-performance">
			{#if perf.hasData}
				<div class="grid gap-6 ws-two-col">
					<div>
						<div class="flex items-center justify-between gap-2 mb-2">
							<p class="text-[11px] text-ws-faint">{$_("reports.perfDimensionCaption")}</p>
							<span class="ws-num text-[11px] text-ws-faint">{$_("reports.perfMembers", { values: { count: perf.memberCount } })}</span>
						</div>
						<BarChart rows={perf.dimensionRows} max={100} />
					</div>
					<div>
						<p class="text-[11px] text-ws-faint mb-2">{$_("reports.perfRoiCaption")}</p>
						<div class="reports-stat-grid">
							<div class="ws-panel-quiet rounded-ws-card px-4 py-3.5">
								<p class="text-[11px] text-ws-faint truncate">{$_("reports.perfTimeSaved")}</p>
								<p class="mt-1 flex items-baseline gap-1 leading-none">
									<NumberValue value={perf.roiTimeSavedHours} compact={false} digits={1} class="text-[20px] font-semibold text-ws-green" />
									<span class="text-[12px] text-ws-faint font-normal">{$_("reports.perfHoursUnit")}</span>
								</p>
							</div>
							<div class="ws-panel-quiet rounded-ws-card px-4 py-3.5">
								<p class="text-[11px] text-ws-faint truncate">{$_("reports.perfValueSaved")}</p>
								<p class="mt-1 leading-none">
									<NumberValue value={perf.roiMoneySavedUsd} prefix="$" compact={true} class="text-[20px] font-semibold text-ws-ink" />
								</p>
							</div>
							<div class="ws-panel-quiet rounded-ws-card px-4 py-3.5">
								<p class="text-[11px] text-ws-faint truncate">{$_("reports.perfTmReuse")}</p>
								<p class="mt-1 leading-none"><NumberValue value={perf.roiTmHits} class="text-[20px] font-semibold text-ws-cyan" /></p>
							</div>
							<div class="ws-panel-quiet rounded-ws-card px-4 py-3.5">
								<p class="text-[11px] text-ws-faint truncate">{$_("reports.perfAiCaught")}</p>
								<p class="mt-1 leading-none"><NumberValue value={perf.roiAiCaughtIssues} class="text-[20px] font-semibold text-ws-violet" /></p>
							</div>
						</div>
					</div>
				</div>
			{:else}
				<div class="reports-empty">
					<p class="reports-empty-title">{$_("reports.perfEmptyTitle")}</p>
					<p>{$_("reports.perfEmptyDetail")}</p>
				</div>
			{/if}
		</div>

		<!-- EXPORT RUN HISTORY -->
		<SectionBand title="export history" subtitle={$_("reports.sectionExportHistory")} class="mt-6" />
		<div class="ws-panel rounded-ws-card p-[clamp(16px,1.8vw,20px)]" data-testid="reports-export-history">
			{#if exportRuns.length > 0}
				<ul class="reports-runs">
					{#each exportRuns as run (run.id)}
						<li class="reports-run ws-panel-quiet" class:error={run.status === "error"}>
							<span class="reports-run-dot" class:ok={run.status === "done"}></span>
							<span class="reports-run-body">
								<span class="reports-run-title">{formatExportRunMessage(run)}</span>
								<span class="reports-run-meta">{formatExportRunPages(run)}{#if formatExportRunSize(run.bytes)} · {formatExportRunSize(run.bytes)}{/if}</span>
							</span>
						</li>
					{/each}
				</ul>
			{:else}
				<div class="reports-empty">
					<p class="reports-empty-title">{hasProject ? $_("reports.historyEmptyHasProject") : $_("reports.historyEmptyNoProject")}</p>
					<p>{$_("reports.historyEmptyDetail")}</p>
				</div>
			{/if}
		</div>

		<!-- REVENUE (permission-gated) -->
		{#if revenueState === "ready" || revenueState === "error"}
			<SectionBand title="revenue" subtitle={$_("reports.sectionRevenue")} class="mt-6" />
			<div class="ws-panel rounded-ws-card p-[clamp(16px,1.8vw,20px)]" data-testid="reports-revenue">
				{#if revenueState === "ready" && revenueSummary}
					{#if revenueSummary.currencies.length > 0}
						<div class="reports-stat-grid">
							{#each revenueSummary.currencies as block (block.currency)}
								<div class="ws-panel-quiet rounded-ws-card px-4 py-3.5">
									<p class="text-[11px] text-ws-faint truncate">{$_("reports.revenueMrr", { values: { currency: block.currency } })}</p>
									<p class="mt-1 text-[20px] font-semibold text-ws-green ws-num">{formatCents(block.mrrCents)}</p>
									<p class="text-[11px] text-ws-faint mt-0.5">{$_("reports.revenueArr", { values: { arr: formatCents(block.arrCents), subs: block.activeSubscriptions } })}</p>
								</div>
							{/each}
						</div>
					{:else}
						<div class="reports-empty">
							<p class="reports-empty-title">{$_("reports.revenueEmptyTitle")}</p>
							<p>{$_("reports.revenueEmptyDetail")}</p>
						</div>
					{/if}
				{:else}
					<div class="reports-empty" data-testid="reports-revenue-error">
						<p class="reports-empty-title">{$_("reports.revenueErrorTitle")}</p>
						<p>{revenueError ?? $_("reports.revenueErrorDetail")}</p>
					</div>
				{/if}
			</div>
		{/if}
		{/if}
		</div>
	</section>
{/if}

<style>
	/* Surface frame (position / scroll / background / typeface) + the centered
	   content column (max-width / padding / vertical rhythm) come from the shared
	   `.ws-surface` + `.ws-surface-inner` utilities in app.css, so Reports lines up
	   with every other workspace surface. Only the report-specific styling lives
	   here. The page header uses the shared WorkspacePageHeader atom. */
	.reports-badge {
		display: inline-flex;
		min-height: 28px;
		align-items: center;
		flex-shrink: 0;
		align-self: center;
		padding: 4px 12px;
		border: 1px solid color-mix(in srgb, var(--color-ws-accent) 24%, transparent);
		border-radius: 999px;
		/* accent/ink mix keeps 11px badge text readable on the soft gradient
		   (raw ws-violet was ~3.65:1) — same mapping as SearchModal/NotificationPanel */
		color: color-mix(in srgb, var(--color-ws-accent) 42%, var(--color-ws-ink));
		font-size: 11px;
		font-weight: 700;
	}

	.reports-stat-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 12px;
		margin-top: 12px;
	}

	.reports-empty {
		padding: 40px 16px;
		text-align: center;
		color: var(--color-ws-faint);
		font-size: 12px;
	}

	/* Consolidated single empty-state card (replaces six stacked placeholders when
		there is genuinely no data anywhere). */
	.reports-empty-hero {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: clamp(40px, 7vw, 64px) clamp(20px, 4vw, 40px);
		border-color: color-mix(in srgb, var(--color-ws-accent) 22%, transparent);
		border-radius: var(--radius-ws-card);
		background:
			radial-gradient(120% 120% at 50% 0%, color-mix(in srgb, var(--color-ws-accent) 12%, transparent), transparent 70%),
			var(--color-ws-surface);
		text-align: center;
	}

	.reports-empty-hero-icon {
		display: grid;
		place-items: center;
		width: 56px;
		height: 56px;
		border-color: color-mix(in srgb, var(--color-ws-accent) 32%, transparent);
		border-radius: var(--radius-ws-card);
		background: color-mix(in srgb, var(--color-ws-accent) 14%, var(--color-ws-surface2));
		color: var(--color-ws-violet);
	}

	.reports-empty-hero-title {
		margin: 0;
		color: var(--color-ws-ink);
		font-size: 16px;
		font-weight: 700;
	}

	.reports-empty-hero-detail {
		margin: 0;
		max-width: 440px;
		color: var(--color-ws-text);
		font-size: 13px;
		line-height: 1.55;
	}

	.reports-empty-title {
		margin-bottom: 4px;
		color: var(--color-ws-text);
		font-weight: 700;
	}

	.reports-runs {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.reports-run {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		min-height: 44px;
		padding: 10px 12px;
		border-radius: var(--radius-ws-card);
	}

	.reports-run.error {
		border-color: color-mix(in srgb, var(--color-ws-rose) 44%, transparent);
		background: color-mix(in srgb, var(--color-ws-rose) 10%, var(--color-ws-surface2));
	}

	.reports-run-dot {
		margin-top: 5px;
		width: 8px;
		height: 8px;
		flex-shrink: 0;
		border-radius: 999px;
		background: var(--color-ws-rose);
	}

	.reports-run-dot.ok {
		background: var(--color-ws-green);
	}

	.reports-run-body {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.reports-run-title {
		color: var(--color-ws-ink);
		font-size: 12.5px;
		font-weight: 700;
	}

	.reports-run-meta {
		color: var(--color-ws-faint);
		font-size: 11px;
	}
</style>
