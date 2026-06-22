<!-- WorkspaceAnalytics - the dashboard's REAL analytics section.
	Renders pipeline throughput, pipeline stage counts, AI-credit + storage trends,
	and anonymized per-dimension team performance + ROI from data the workspace has
	actually recorded. Every number is real: when a source has no data the relevant
	card shows an honest empty state (zeros / "no data yet"), never a fabricated
	figure or invented time series. Built from small chart atoms (Sparkline /
	BarChart / StatTrend) per the component-decomposition principle. -->
<script lang="ts">
	import { _ } from "$lib/i18n";
	import { usageStore, formatBytes, thbToCredits, formatCreditsCompact } from "$lib/stores/usage.svelte.ts";
	import { perfAnalyticsStore } from "$lib/stores/perf-analytics.svelte.ts";
	import {
		buildPipelineThroughputRows,
		buildPipelineStageCountRows,
		buildUsageTrend,
		buildStorageBreakdownRows,
		buildPerfAnalytics,
		pipelineHasAnyData,
		type PipelineStageInput,
	} from "$lib/project/workspace-analytics.ts";
	import SectionBand from "$lib/components/ui/SectionBand.svelte";
	import BarChart from "$lib/components/ui/BarChart.svelte";
	import StatTrend from "$lib/components/ui/StatTrend.svelte";
	import NumberValue from "$lib/components/ui/NumberValue.svelte";

	let {
		pipelineStages,
		hasProject = false,
	}: {
		// Real pipeline stage counts the dashboard already computes from job lanes.
		pipelineStages: PipelineStageInput[];
		hasProject?: boolean;
	} = $props();

	// ── Pipeline (real, from the open chapter's job lanes) ──
	let throughputRows = $derived(buildPipelineThroughputRows(pipelineStages));
	let stageCountRows = $derived(buildPipelineStageCountRows(pipelineStages));
	let pipelineLive = $derived(hasProject && pipelineHasAnyData(pipelineStages));
	let totalPagesDone = $derived(throughputRows.reduce((sum, row) => sum + row.doneCount, 0));
	let totalPagesRouted = $derived(throughputRows.reduce((sum, row) => sum + row.totalCount, 0));
	let totalOpen = $derived(stageCountRows.reduce((sum, row) => sum + row.value, 0));

	// ── Usage (real: today vs this-month windows + storage snapshot) ──
	let usageTrend = $derived(buildUsageTrend(usageStore.dashboard));
	let storageRows = $derived(
		buildStorageBreakdownRows(usageStore.dashboard, {
			used: msg("dashboard.storageUsed", "ใช้ไป"),
			reserved: msg("dashboard.storageReserved", "จองไว้"),
			free: msg("dashboard.storageFree", "เหลือ"),
		}),
	);
	let storagePct = $derived(usageStore.storagePct);
	let aiPct = $derived(Math.min(100, usageStore.aiPct));

	// ── Performance (real anonymized aggregate + ROI) ──
	let perf = $derived(
		buildPerfAnalytics(perfAnalyticsStore.aggregate, {
			throughput: msg("dashboard.perfThroughput", "ความเร็ว"),
			quality: msg("dashboard.perfQuality", "คุณภาพ"),
			consistency: msg("dashboard.perfConsistency", "สม่ำเสมอ"),
			ai_leverage: msg("dashboard.perfAiLeverage", "ใช้ AI"),
			collaboration: msg("dashboard.perfCollaboration", "ทำงานร่วม"),
		}),
	);

	function msg(key: string, fallback: string): string {
		const value = $_(key);
		return value && value !== key ? value : fallback;
	}
</script>

<SectionBand title="analytics" subtitle={msg("dashboard.analyticsSubtitle", "วิเคราะห์งาน")} class="pt-2 pb-2 mb-3">
	{#snippet action()}
		<span class="ws-num text-[11px] text-ws-faint">{msg("dashboard.analyticsRealOnly", "ข้อมูลจริงเท่านั้น")}</span>
	{/snippet}
</SectionBand>

<div class="grid gap-6 ws-two-col" data-tour="analytics">

	<!-- LEFT: pipeline throughput + stage counts (real) -->
	<div class="ws-panel rounded-ws-card p-[clamp(16px,1.8vw,20px)]">
		<div class="flex items-center justify-between gap-2 mb-3.5 flex-wrap">
			<h3 class="text-[14px] font-semibold text-ws-ink">{msg("dashboard.pipelineThroughput", "สายงานผลิต")} <span class="text-ws-faint font-normal text-[12px] ml-1">· pipeline throughput</span></h3>
			{#if pipelineLive}
				<span class="ws-num text-[11px] text-ws-faint">
					{msg("dashboard.doneWord", "เสร็จ")} <NumberValue value={totalPagesDone} class="text-ws-ink font-medium" />/<NumberValue value={totalPagesRouted} class="text-ws-ink font-medium" /> {msg("dashboard.pagesUnit", "หน้า")}
				</span>
			{/if}
		</div>

		{#if pipelineLive}
			<p class="text-[11px] text-ws-faint mb-1.5">{msg("dashboard.pagesPerStage", "หน้าที่ทำเสร็จในแต่ละขั้น · คลีน → แปล → ไทป์เซ็ต → QC")}</p>
			<BarChart rows={throughputRows} class="mb-4" />

			<div class="border-t border-ws-line/[0.07] pt-3.5">
				<div class="flex items-center justify-between gap-2 mb-1.5">
					<p class="text-[11px] text-ws-faint">{msg("dashboard.openPerStage", "งานที่ยังเปิดอยู่ในแต่ละขั้น")}</p>
					<span class="ws-num text-[11px] text-ws-faint">{msg("dashboard.openWord", "เปิด")} <NumberValue value={totalOpen} class="text-ws-ink font-medium" /> {msg("dashboard.jobsUnit", "งาน")}</span>
				</div>
				<BarChart rows={stageCountRows} valueSuffix={` ${msg("dashboard.jobsUnit", "งาน")}`} />
			</div>
		{:else}
			<div class="text-center py-10 text-ws-faint text-[12px]">
				<p class="font-medium text-ws-text mb-1">{hasProject ? msg("dashboard.pipelineEmptyHasProject", "ยังไม่มีงานในสายการผลิต") : msg("dashboard.pipelineEmptyNoProject", "เปิดตอนเพื่อดูสายงานผลิต")}</p>
				<p>{msg("dashboard.pipelineEmptyHint", "เมื่อเริ่มคลีน แปล ไทป์เซ็ต หรือตรวจ ระบบจะนับความคืบหน้าจริงให้ที่นี่")}</p>
			</div>
		{/if}
	</div>

	<!-- RIGHT: usage trend (AI credits + storage) — real today vs month -->
	<div class="ws-panel rounded-ws-card p-[clamp(16px,1.8vw,20px)]">
		<div class="flex items-center justify-between gap-2 mb-3.5 flex-wrap">
			<h3 class="text-[14px] font-semibold text-ws-ink">{msg("dashboard.usageTrend", "การใช้งาน")} <span class="text-ws-faint font-normal text-[12px] ml-1">· usage trend</span></h3>
		</div>

		{#if usageTrend.hasData}
			<div class="grid grid-cols-2 gap-3 mb-4">
				<!-- AI credit: today's spend (in CREDITS) with this-month as the baseline (2 real points). -->
				<StatTrend
					label={msg("dashboard.aiCreditsToday", "AI credits · วันนี้")}
					value={thbToCredits(usageTrend.daily.aiCommittedThb)}
					previous={thbToCredits(usageTrend.monthly.aiCommittedThb)}
					suffix={` ${$_("credits.unit")}`}
					tone="violet"
					higherIsBetter={false}
					series={usageTrend.aiSeries.map((v) => thbToCredits(v))}
					caption={`${$_("dashboard.aiThisMonth", { values: { value: formatCreditsCompact(thbToCredits(usageTrend.monthly.aiCommittedThb)) } })}${usageTrend.monthly.aiLimitThb > 0 ? ` / ${formatCreditsCompact(thbToCredits(usageTrend.monthly.aiLimitThb))}` : ""} · ${aiPct.toFixed(0)}%`}
				/>
				<StatTrend
					label={msg("dashboard.storageUsedLabel", "Storage · ใช้ไป")}
					value={usageTrend.monthly.storageUsedBytes}
					prefix=""
					compact={true}
					tone="violet"
					higherIsBetter={false}
					caption={`${formatBytes(usageTrend.monthly.storageUsedBytes)}${usageTrend.monthly.storageLimitBytes > 0 ? ` / ${formatBytes(usageTrend.monthly.storageLimitBytes)}` : ""} · ${storagePct.toFixed(0)}%`}
				/>
			</div>

			<div class="border-t border-ws-line/[0.07] pt-3.5">
				<p class="text-[11px] text-ws-faint mb-2">{msg("dashboard.storageBreakdown", "องค์ประกอบพื้นที่จัดเก็บ")} · storage breakdown</p>
				<BarChart
					rows={storageRows}
					valueSuffix=""
					emptyLabel={msg("dashboard.storageBreakdownEmpty", "ยังไม่มีไฟล์จัดเก็บ")}
				/>
			</div>
		{:else}
			<div class="text-center py-10 text-ws-faint text-[12px]">
				<p class="font-medium text-ws-text mb-1">{msg("dashboard.loadingUsage", "กำลังโหลดการใช้งานของเวิร์กสเปซ…")}</p>
				<p>{msg("dashboard.usageEmptyHint", "เครดิต AI และพื้นที่จัดเก็บจริงจะแสดงที่นี่เมื่อข้อมูลพร้อม")}</p>
			</div>
		{/if}
	</div>
</div>

<!-- TEAM PERFORMANCE (anonymized aggregate, all members) -->
<div class="ws-panel rounded-ws-card p-[clamp(16px,1.8vw,20px)] mt-6">
	<div class="flex items-center justify-between gap-2 mb-3.5 flex-wrap">
		<h3 class="text-[14px] font-semibold text-ws-ink">{msg("dashboard.teamPerformance", "ประสิทธิภาพทีม")} <span class="text-ws-faint font-normal text-[12px] ml-1">· team performance</span></h3>
		{#if perf.hasData}
			<span class="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-ws-line/15 px-2.5 text-[11px] font-semibold text-[color-mix(in_srgb,var(--color-ws-accent)_42%,var(--color-ws-ink))] ws-grad-primary-soft">
				<span class="ws-dot bg-ws-violet"></span>
				{msg("dashboard.compositeScore", "คะแนนรวม")} <NumberValue value={perf.medianComposite} class="font-semibold" />
			</span>
		{/if}
	</div>

	{#if perf.hasData}
		{#if perf.windowTruncated}
			<!-- The backend capped the window scan and dropped the oldest events, so
				these medians/ROI cover only the most recent N events, not the full
				period. Flag it so the figures are never read as complete. -->
			<p class="text-[11px] text-ws-amber mb-3" role="status">
				{$_("dashboard.windowTruncated", { values: { n: perf.windowEventLimit } })}
			</p>
		{/if}
		<div class="grid gap-6 ws-two-col">
			<!-- per-dimension medians (real) -->
			<div>
				<div class="flex items-center justify-between gap-2 mb-2">
					<p class="text-[11px] text-ws-faint">{msg("dashboard.medianByDimension", "คะแนนกลางตามมิติงาน · 0–100")}</p>
					<span class="ws-num text-[11px] text-ws-faint"><NumberValue value={perf.memberCount} class="text-ws-ink font-medium" /> {msg("dashboard.membersWithData", "สมาชิกมีข้อมูล")}</span>
				</div>
				<BarChart rows={perf.dimensionRows} max={100} />
			</div>

			<!-- ROI (real, derived from work events) -->
			<div>
				<p class="text-[11px] text-ws-faint mb-2">{msg("dashboard.roiLabel", "ผลตอบแทนจากเครื่องมือ · ROI (4 สัปดาห์)")}</p>
				<div class="grid grid-cols-2 gap-3">
					<div class="ws-panel-quiet rounded-ws-card px-4 py-3.5">
						<p class="text-[11px] text-ws-faint truncate">{msg("dashboard.roiTimeSaved", "เวลาที่ประหยัด")}</p>
						<p class="mt-1 flex items-baseline gap-1 leading-none">
							<NumberValue value={perf.roiTimeSavedHours} compact={false} digits={1} class="text-[20px] font-semibold text-ws-green" />
							<span class="text-[12px] text-ws-faint font-normal">{msg("dashboard.roiHoursUnit", "ชม.")}</span>
						</p>
					</div>
					<div class="ws-panel-quiet rounded-ws-card px-4 py-3.5">
						<p class="text-[11px] text-ws-faint truncate">{msg("dashboard.roiMoneySaved", "มูลค่าที่ประหยัด")}</p>
						<p class="mt-1 leading-none">
							<NumberValue value={perf.roiMoneySavedUsd} prefix="$" compact={true} class="text-[20px] font-semibold text-ws-ink" />
						</p>
					</div>
					<div class="ws-panel-quiet rounded-ws-card px-4 py-3.5">
						<p class="text-[11px] text-ws-faint truncate">{msg("dashboard.roiTmReuse", "TM ใช้ซ้ำ")}</p>
						<p class="mt-1 leading-none">
							<NumberValue value={perf.roiTmHits} class="text-[20px] font-semibold text-ws-cyan" />
						</p>
					</div>
					<div class="ws-panel-quiet rounded-ws-card px-4 py-3.5">
						<p class="text-[11px] text-ws-faint truncate">{msg("dashboard.roiAiCaught", "AI ช่วยจับ")}</p>
						<p class="mt-1 leading-none">
							<NumberValue value={perf.roiAiCaughtIssues} class="text-[20px] font-semibold text-ws-violet" />
						</p>
					</div>
				</div>
			</div>
		</div>
	{:else}
		<div class="text-center py-10 text-ws-faint text-[12px]">
			<p class="font-medium text-ws-text mb-1">{msg("dashboard.perfEmpty", "ยังไม่มีข้อมูลประสิทธิภาพ")}</p>
			<p>{msg("dashboard.perfEmptyHint", "เมื่อทีมส่งหน้า รีวิวงาน หรือใช้ AI/TM ระบบจะสรุปคะแนนและ ROI จริง (ไม่ระบุตัวบุคคล) ที่นี่")}</p>
		</div>
	{/if}
</div>
