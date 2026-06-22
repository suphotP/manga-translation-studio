// Workspace dashboard analytics — PURE builders.
//
// Turns the REAL data the dashboard already loads (usage dashboard, performance
// aggregate, pipeline stage counts, chapter summary) into chart-ready rows.
// Everything here is honest: no fabricated numbers, no interpolated series. When
// a source has no data the builders return empty rows / zeroed metrics so the UI
// renders a genuine empty state instead of inventing a trend.

import type { UsageDashboard, PerfWorkspaceAggregate, PerfDimensionKey } from "$lib/api/client.ts";
import type { BarChartRow } from "$lib/components/ui/BarChart.svelte";

/**
 * Coerce a possibly-missing numeric input to a finite, non-negative number.
 * Counts and usage values arrive from partial/in-flight server payloads where a
 * field can be `undefined`, `null`, `NaN`, `Infinity`, or negative. Math.round /
 * Math.max on `undefined` yields `NaN`, which then leaks into chart geometry and
 * value labels. Routing every count/value through this keeps partial/missing data
 * honest: it renders as 0, never `NaN` and never a throw.
 */
export function finiteNonNegative(n: unknown): number {
	const value = typeof n === "number" ? n : Number(n);
	if (!Number.isFinite(value) || value <= 0) return 0;
	return value;
}

// ── Pipeline throughput ───────────────────────────────────────────────────────

export interface PipelineStageInput {
	id: string;
	labelTh: string;
	/** Pages completed in this stage (the leading "done" of done/total). */
	doneCount: number;
	/** Total pages routed through this stage. */
	totalCount: number;
	/** Currently-open work units in this stage. */
	openCount: number;
}

export interface PipelineThroughputRow extends BarChartRow {
	doneCount: number;
	totalCount: number;
}

const PIPELINE_TONE: Record<string, BarChartRow["tone"]> = {
	clean: "cyan",
	translate: "violet",
	typeset: "blue",
	review: "green",
};

/**
 * Pages completed per pipeline stage (Clean → Translate → Typeset → QC). Bars are
 * the REAL done counts; the value label keeps the done/total denominator so a
 * stage with no pages reads honestly as 0/0. Stages with no total are still shown
 * (at zero) so the four-stage pipeline shape is always visible.
 */
export function buildPipelineThroughputRows(stages: PipelineStageInput[]): PipelineThroughputRow[] {
	return stages.map((stage) => {
		const done = Math.round(finiteNonNegative(stage.doneCount));
		const total = Math.round(finiteNonNegative(stage.totalCount));
		return {
			id: stage.id,
			label: stage.labelTh,
			value: done,
			valueLabel: total > 0 ? `${done}/${total}` : "0",
			tone: PIPELINE_TONE[stage.id] ?? "violet",
			doneCount: done,
			totalCount: total,
		};
	});
}

/**
 * Open work units per pipeline stage — the real "where is work sitting now"
 * snapshot. Distinct from throughput (completed): this counts what is still open.
 */
export function buildPipelineStageCountRows(stages: PipelineStageInput[]): BarChartRow[] {
	return stages.map((stage) => ({
		id: stage.id,
		label: stage.labelTh,
		value: Math.round(finiteNonNegative(stage.openCount)),
		tone: PIPELINE_TONE[stage.id] ?? "violet",
	}));
}

export function pipelineHasAnyData(stages: PipelineStageInput[]): boolean {
	return stages.some(
		(stage) =>
			finiteNonNegative(stage.totalCount) > 0 ||
			finiteNonNegative(stage.openCount) > 0 ||
			finiteNonNegative(stage.doneCount) > 0,
	);
}

// ── AI credit + storage trend (2 real points: today vs this month) ─────────────

export interface UsageTrendPoint {
	/** AI credit committed THB (captured + active reserved). */
	aiCommittedThb: number;
	aiLimitThb: number;
	/** Storage used bytes (projected: used + pending + reserved). */
	storageUsedBytes: number;
	storageLimitBytes: number;
}

export interface UsageTrend {
	hasData: boolean;
	/** Today's window (UTC day). */
	daily: UsageTrendPoint;
	/** This month's window (UTC month). The daily figure is a subset of this. */
	monthly: UsageTrendPoint;
	/** A real 2-point AI series [today, month] for a StatTrend delta — NOT a fake history. */
	aiSeries: number[];
}

/**
 * Extract the REAL AI-credit + storage figures from the usage dashboard. We have
 * exactly two genuine windows (daily, monthly) plus the storage snapshot — never
 * a fabricated multi-day history. `hasData` is false when the dashboard is absent
 * so the UI can show an honest loading/empty state.
 */
export function buildUsageTrend(dashboard: UsageDashboard | null): UsageTrend {
	if (!dashboard) {
		const empty: UsageTrendPoint = { aiCommittedThb: 0, aiLimitThb: 0, storageUsedBytes: 0, storageLimitBytes: 0 };
		return { hasData: false, daily: { ...empty }, monthly: { ...empty }, aiSeries: [] };
	}
	const committed = (window: UsageDashboard["totals"]["daily"] | undefined | null): number =>
		round4(finiteNonNegative(window?.aiCommittedThb) + finiteNonNegative(window?.aiActiveReservedThb));
	const storage = dashboard.storage ?? null;
	const storageUsed = finiteNonNegative(storage?.projectedBytes ?? storage?.usedBytes);
	const storageLimit = finiteNonNegative(storage?.limitBytes);
	const daily: UsageTrendPoint = {
		aiCommittedThb: committed(dashboard.totals?.daily),
		aiLimitThb: finiteNonNegative(dashboard.totals?.daily?.limits?.aiCreditThb),
		storageUsedBytes: storageUsed,
		storageLimitBytes: storageLimit,
	};
	const monthly: UsageTrendPoint = {
		aiCommittedThb: committed(dashboard.totals?.monthly),
		aiLimitThb: finiteNonNegative(dashboard.totals?.monthly?.limits?.aiCreditThb),
		storageUsedBytes: storageUsed,
		storageLimitBytes: storageLimit,
	};
	return {
		hasData: true,
		daily,
		monthly,
		// Two honest points: today's spend and the month-to-date spend.
		aiSeries: [daily.aiCommittedThb, monthly.aiCommittedThb],
	};
}

/**
 * Storage composition (used vs reserved vs free) in bytes — a real breakdown of
 * the storage snapshot, suitable for a stacked-meaning bar chart.
 */
export interface StorageBreakdownLabels {
	used: string;
	reserved: string;
	free: string;
}

const STORAGE_BREAKDOWN_LABELS_TH: StorageBreakdownLabels = {
	used: "ใช้ไป",
	reserved: "จองไว้",
	free: "เหลือ",
};

export function buildStorageBreakdownRows(
	dashboard: UsageDashboard | null,
	// Optional localized labels; defaults to Thai for backward compatibility
	// (callers that have a locale, e.g. the dashboard, pass translated labels).
	labels: StorageBreakdownLabels = STORAGE_BREAKDOWN_LABELS_TH,
): BarChartRow[] {
	if (!dashboard || !dashboard.storage) return [];
	const storage = dashboard.storage;
	const used = Math.round(finiteNonNegative(storage.usedBytes));
	const reserved = Math.round(finiteNonNegative(storage.reservedBytes));
	const free = Math.round(finiteNonNegative(storage.remainingBytes));
	return [
		{ id: "used", label: labels.used, value: used, tone: "violet" },
		{ id: "reserved", label: labels.reserved, value: reserved, tone: "amber" },
		{ id: "free", label: labels.free, value: free, tone: "green" },
	];
}

// ── Per-member / per-dimension performance ─────────────────────────────────────

export const PERF_DIMENSION_LABELS_TH: Record<PerfDimensionKey, string> = {
	throughput: "ความเร็ว",
	quality: "คุณภาพ",
	consistency: "สม่ำเสมอ",
	ai_leverage: "ใช้ AI",
	collaboration: "ทำงานร่วม",
};

const PERF_DIMENSION_ORDER: PerfDimensionKey[] = [
	"throughput",
	"quality",
	"consistency",
	"ai_leverage",
	"collaboration",
];

export interface PerfAnalytics {
	hasData: boolean;
	memberCount: number;
	medianComposite: number;
	dimensionRows: BarChartRow[];
	roiTimeSavedHours: number;
	roiMoneySavedUsd: number;
	roiTmHits: number;
	roiAiCaughtIssues: number;
	periodStart: string;
	/**
	 * True when the backend capped the window scan and dropped the oldest events,
	 * so these medians/ROI reflect only the most recent `windowEventLimit` events
	 * rather than the full period. The UI flags this so a truncated scan is never
	 * presented as a complete-period figure.
	 */
	windowTruncated: boolean;
	/** The cap that was applied ("showing the latest N events"); 0 when unknown. */
	windowEventLimit: number;
}

function perfTone(score: number): BarChartRow["tone"] {
	if (score >= 75) return "green";
	if (score >= 50) return "violet";
	if (score >= 30) return "amber";
	return "rose";
}

/**
 * Build the workspace performance view from the ANONYMIZED aggregate (real
 * per-dimension medians + ROI). `hasData` is false when no work events have been
 * recorded (memberCount 0), so the UI shows an honest "no performance data yet"
 * empty state rather than the role-baseline anchors that the aggregate would
 * otherwise emit for an empty workspace.
 */
export function buildPerfAnalytics(
	aggregate: PerfWorkspaceAggregate | null,
	// Optional localized per-dimension labels; defaults to Thai for backward
	// compatibility (the dashboard passes translated labels).
	dimensionLabels: Record<PerfDimensionKey, string> = PERF_DIMENSION_LABELS_TH,
): PerfAnalytics {
	// finiteNonNegative also normalises a missing/NaN memberCount to 0, so the
	// guard below treats partial payloads as "no data" instead of falling through
	// (where `aggregate.dimensionMedians` could be undefined and throw).
	const memberCount = Math.round(finiteNonNegative(aggregate?.memberCount));
	if (!aggregate || memberCount <= 0) {
		return {
			hasData: false,
			memberCount,
			medianComposite: 0,
			dimensionRows: [],
			roiTimeSavedHours: 0,
			roiMoneySavedUsd: 0,
			roiTmHits: 0,
			roiAiCaughtIssues: 0,
			periodStart: aggregate?.periodStart ?? "",
			windowTruncated: false,
			windowEventLimit: 0,
		};
	}
	// Null-safe defaults: a partial aggregate may omit dimensionMedians / roi.
	const dimensionMedians: Partial<Record<PerfDimensionKey, number>> = aggregate.dimensionMedians ?? {};
	const roi = aggregate.roi ?? null;
	const dimensionRows: BarChartRow[] = PERF_DIMENSION_ORDER.map((dimension) => {
		const score = Math.round(finiteNonNegative(dimensionMedians[dimension]) * 10) / 10;
		return {
			id: dimension,
			label: dimensionLabels[dimension],
			value: score,
			valueLabel: String(score),
			tone: perfTone(score),
		};
	});
	return {
		hasData: true,
		memberCount,
		medianComposite: Math.round(finiteNonNegative(aggregate.medianComposite) * 10) / 10,
		dimensionRows,
		roiTimeSavedHours: finiteNonNegative(roi?.timeSavedHours),
		roiMoneySavedUsd: finiteNonNegative(roi?.moneySavedUsd),
		roiTmHits: finiteNonNegative(roi?.tmHits),
		roiAiCaughtIssues: finiteNonNegative(roi?.aiCaughtIssues),
		periodStart: aggregate.periodStart ?? "",
		// Surface the backend truncation flag so the dashboard can flag a recent-only
		// window. `=== true` keeps a missing/legacy field honestly non-truncated.
		windowTruncated: aggregate.windowTruncated === true,
		windowEventLimit: Math.round(finiteNonNegative(aggregate.windowEventLimit)),
	};
}

function round4(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.round(value * 10000) / 10000;
}
