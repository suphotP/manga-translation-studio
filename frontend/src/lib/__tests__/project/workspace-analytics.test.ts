import { describe, expect, it } from "vitest";
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
import type { UsageDashboard, PerfWorkspaceAggregate } from "$lib/api/client.ts";

function stage(overrides: Partial<PipelineStageInput> = {}): PipelineStageInput {
	return { id: "clean", labelTh: "คลีน", doneCount: 0, totalCount: 0, openCount: 0, ...overrides };
}

function usageDashboard(overrides: Partial<UsageDashboard> = {}): UsageDashboard {
	const window = {
		periodKey: "2026-06",
		aiCapturedThb: 0,
		aiActiveReservedThb: 0,
		aiCommittedThb: 0,
		uploadBytes: 0,
		exportBytes: 0,
		moderationImages: 0,
		limits: { aiCreditThb: 0, uploadBytes: 0, exportBytes: 0 },
		remaining: { aiCreditThb: null, uploadBytes: null, exportBytes: null },
	};
	return {
		workspaceId: "ws-1",
		scope: "filesystem",
		enforced: false,
		plan: { id: "free", name: "Free", monthlyAiCredits: 0, includedStorageBytes: 0, maxSeatsIncluded: 1 },
		projectIds: [],
		projectCount: 0,
		totals: { daily: { ...window }, monthly: { ...window }, eventCount: 0, eventCountCapped: false },
		storage: {
			usedBytes: 0,
			originalBytes: 0,
			derivativeBytes: 0,
			exportArtifactBytes: 0,
			reservedBytes: 0,
			projectedBytes: 0,
			limitBytes: 0,
			includedBytes: 0,
			extraBytes: 0,
			remainingBytes: 0,
			percentUsed: 0,
			enforced: false,
		},
		egress: { windowMs: 0, totalRequests: 0, totalBytes: 0, limitBytes: 0, remainingBytes: 0, enforced: false, perProjectEnforced: false, projects: [] },
		memberAttribution: "unattributed",
		members: { count: 0, breakdown: [], unattributed: { aiCommittedThb: 0, uploadBytes: 0, exportBytes: 0 } },
		...overrides,
	};
}

describe("workspace-analytics pipeline", () => {
	it("builds throughput rows with real done counts and a done/total label", () => {
		const rows = buildPipelineThroughputRows([
			stage({ id: "clean", doneCount: 3, totalCount: 5 }),
			stage({ id: "translate", labelTh: "แปล", doneCount: 0, totalCount: 0 }),
		]);
		expect(rows[0]).toMatchObject({ id: "clean", value: 3, valueLabel: "3/5", tone: "cyan" });
		// A stage with no pages stays honest at 0 (not hidden, not fabricated).
		expect(rows[1]).toMatchObject({ id: "translate", value: 0, valueLabel: "0" });
	});

	it("builds open stage-count rows from real open counts", () => {
		const rows = buildPipelineStageCountRows([stage({ openCount: 4 }), stage({ id: "review", labelTh: "QC", openCount: 0 })]);
		expect(rows.map((row) => row.value)).toEqual([4, 0]);
	});

	it("reports no pipeline data when every stage is empty", () => {
		expect(pipelineHasAnyData([stage(), stage({ id: "translate" })])).toBe(false);
		expect(pipelineHasAnyData([stage({ doneCount: 1 })])).toBe(true);
		expect(pipelineHasAnyData([stage({ openCount: 2 })])).toBe(true);
	});
});

describe("workspace-analytics usage", () => {
	it("returns no-data trend when the dashboard is absent (honest empty)", () => {
		const trend = buildUsageTrend(null);
		expect(trend.hasData).toBe(false);
		expect(trend.aiSeries).toEqual([]);
		expect(trend.daily.aiCommittedThb).toBe(0);
		expect(buildStorageBreakdownRows(null)).toEqual([]);
	});

	it("extracts real committed AI (captured + reserved) for today vs this month", () => {
		const dashboard = usageDashboard({
			totals: {
				// committed = aiCommittedThb + aiActiveReservedThb (matches usageStore).
				daily: { ...usageDashboard().totals.daily, aiCommittedThb: 2, aiActiveReservedThb: 1, limits: { aiCreditThb: 50, uploadBytes: 0, exportBytes: 0 } },
				monthly: { ...usageDashboard().totals.monthly, aiCommittedThb: 12, aiActiveReservedThb: 3, limits: { aiCreditThb: 500, uploadBytes: 0, exportBytes: 0 } },
				eventCount: 5,
				eventCountCapped: false,
			},
			storage: { ...usageDashboard().storage, usedBytes: 1000, reservedBytes: 200, remainingBytes: 800, projectedBytes: 1200, limitBytes: 2000 },
		});
		const trend = buildUsageTrend(dashboard);
		expect(trend.hasData).toBe(true);
		expect(trend.daily.aiCommittedThb).toBe(3);
		expect(trend.monthly.aiCommittedThb).toBe(15);
		// Two real points: [today, month] — not a fabricated multi-day history.
		expect(trend.aiSeries).toEqual([3, 15]);
		// Storage uses the projected snapshot.
		expect(trend.monthly.storageUsedBytes).toBe(1200);
	});

	it("builds a real used/reserved/free storage breakdown", () => {
		const dashboard = usageDashboard({
			storage: { ...usageDashboard().storage, usedBytes: 1000, reservedBytes: 200, remainingBytes: 800 },
		});
		const rows = buildStorageBreakdownRows(dashboard);
		expect(rows.map((row) => [row.id, row.value])).toEqual([
			["used", 1000],
			["reserved", 200],
			["free", 800],
		]);
	});
});

describe("workspace-analytics performance", () => {
	function aggregate(overrides: Partial<PerfWorkspaceAggregate> = {}): PerfWorkspaceAggregate {
		return {
			workspaceId: "ws-1",
			periodStart: "2026-05-07T00:00:00.000Z",
			memberCount: 0,
			medianComposite: 0,
			dimensionMedians: { throughput: 0, quality: 0, consistency: 0, ai_leverage: 0, collaboration: 0 },
			roi: { tmHits: 0, aiCaughtIssues: 0, timeSavedMinutes: 0, timeSavedHours: 0, moneySavedUsd: 0, hourlyRateUsd: 20 },
			computedAt: "2026-06-03T00:00:00.000Z",
			...overrides,
		};
	}

	it("is empty when no members have recorded events (honest, not role baselines)", () => {
		expect(buildPerfAnalytics(null).hasData).toBe(false);
		// memberCount 0 means the aggregate's baseline anchors are not real signal.
		const perf = buildPerfAnalytics(aggregate({ memberCount: 0, medianComposite: 60 }));
		expect(perf.hasData).toBe(false);
		expect(perf.dimensionRows).toEqual([]);
	});

	it("surfaces real dimension medians + ROI when members have data", () => {
		const perf = buildPerfAnalytics(aggregate({
			memberCount: 2,
			medianComposite: 71.4,
			dimensionMedians: { throughput: 80, quality: 65, consistency: 40, ai_leverage: 25, collaboration: 70 },
			roi: { tmHits: 12, aiCaughtIssues: 4, timeSavedMinutes: 90, timeSavedHours: 1.5, moneySavedUsd: 30, hourlyRateUsd: 20 },
		}));
		expect(perf.hasData).toBe(true);
		expect(perf.memberCount).toBe(2);
		expect(perf.medianComposite).toBe(71.4);
		const byId = Object.fromEntries(perf.dimensionRows.map((row) => [row.id, row]));
		expect(byId.throughput).toMatchObject({ value: 80, tone: "green" });
		expect(byId.consistency).toMatchObject({ value: 40, tone: "amber" });
		expect(byId.ai_leverage).toMatchObject({ value: 25, tone: "rose" });
		expect(perf.roiTimeSavedHours).toBe(1.5);
		expect(perf.roiMoneySavedUsd).toBe(30);
		expect(perf.roiTmHits).toBe(12);
		expect(perf.roiAiCaughtIssues).toBe(4);
	});

	it("threads the backend window-truncation flag + cap so the UI can flag a recent-only window", () => {
		const truncated = buildPerfAnalytics(aggregate({
			memberCount: 3,
			medianComposite: 60,
			windowTruncated: true,
			windowEventLimit: 50000,
		}));
		expect(truncated.windowTruncated).toBe(true);
		expect(truncated.windowEventLimit).toBe(50000);

		// A complete (un-capped) window reports an honest non-truncated figure.
		const complete = buildPerfAnalytics(aggregate({ memberCount: 3, medianComposite: 60 }));
		expect(complete.windowTruncated).toBe(false);

		// A legacy payload missing the field is treated as not truncated (additive).
		const legacy = buildPerfAnalytics(aggregate({
			memberCount: 3,
			medianComposite: 60,
			windowTruncated: undefined,
			windowEventLimit: undefined,
		}));
		expect(legacy.windowTruncated).toBe(false);
		expect(legacy.windowEventLimit).toBe(0);
	});
});

// ── Partial / NaN / missing inputs (P2: builders must never emit NaN or throw) ──
//
// Server payloads can arrive partial or mid-flight (undefined fields, NaN/Infinity
// from a bad division, negative noise). Every count/value must collapse to an
// honest 0 — never NaN, never a throw — so the charts render a real empty/zero
// state instead of "NaN%".

describe("finiteNonNegative", () => {
	it("collapses missing / NaN / non-finite / negative to 0, keeps real values", () => {
		expect(finiteNonNegative(undefined)).toBe(0);
		expect(finiteNonNegative(null)).toBe(0);
		expect(finiteNonNegative(Number.NaN)).toBe(0);
		expect(finiteNonNegative(Number.POSITIVE_INFINITY)).toBe(0);
		expect(finiteNonNegative(Number.NEGATIVE_INFINITY)).toBe(0);
		expect(finiteNonNegative(-5)).toBe(0);
		expect(finiteNonNegative("not-a-number")).toBe(0);
		expect(finiteNonNegative(0)).toBe(0);
		expect(finiteNonNegative(3.5)).toBe(3.5);
		expect(finiteNonNegative("12")).toBe(12);
	});
});

describe("workspace-analytics partial / NaN safety", () => {
	it("pipeline rows are NaN-free when stage counts are missing/NaN/negative", () => {
		const dirty = [
			// Cast through unknown so we can model the partial/garbage payloads the
			// server can realistically emit despite the (non-optional) TS types.
			{ id: "clean", labelTh: "คลีน", doneCount: Number.NaN, totalCount: undefined, openCount: -3 } as unknown as PipelineStageInput,
			{ id: "translate", labelTh: "แปล", doneCount: 2.6, totalCount: 5, openCount: Number.POSITIVE_INFINITY } as unknown as PipelineStageInput,
		];
		const throughput = buildPipelineThroughputRows(dirty);
		expect(throughput[0]).toMatchObject({ value: 0, valueLabel: "0" });
		expect(Number.isNaN(throughput[0].value)).toBe(false);
		expect(throughput[1]).toMatchObject({ value: 3, valueLabel: "3/5" });

		const counts = buildPipelineStageCountRows(dirty);
		expect(counts.map((row) => row.value)).toEqual([0, 0]);
		expect(counts.every((row) => Number.isFinite(row.value))).toBe(true);

		// No real signal in any field -> honest "no data".
		expect(pipelineHasAnyData(dirty.slice(0, 1))).toBe(false);
	});

	it("usage trend stays 0 (not NaN) when totals/limits/storage are missing", () => {
		const partial = {
			workspaceId: "ws-1",
			scope: "filesystem",
			enforced: false,
			plan: { id: "free", name: "Free", monthlyAiCredits: 0, includedStorageBytes: 0, maxSeatsIncluded: 1 },
			projectIds: [],
			projectCount: 0,
			// totals + storage omitted entirely (partial payload).
		} as unknown as UsageDashboard;
		const trend = buildUsageTrend(partial);
		expect(trend.hasData).toBe(true);
		for (const value of [
			trend.daily.aiCommittedThb,
			trend.daily.aiLimitThb,
			trend.daily.storageUsedBytes,
			trend.monthly.aiCommittedThb,
			trend.monthly.storageLimitBytes,
			...trend.aiSeries,
		]) {
			expect(Number.isFinite(value)).toBe(true);
		}
		expect(trend.aiSeries).toEqual([0, 0]);
		// Missing storage -> empty breakdown, never a throw.
		expect(buildStorageBreakdownRows(partial)).toEqual([]);
	});

	it("storage breakdown clamps NaN/negative byte counts to 0", () => {
		const dashboard = usageDashboard({
			storage: { ...usageDashboard().storage, usedBytes: Number.NaN, reservedBytes: -100, remainingBytes: undefined as unknown as number },
		});
		const rows = buildStorageBreakdownRows(dashboard);
		expect(rows.map((row) => row.value)).toEqual([0, 0, 0]);
		expect(rows.every((row) => Number.isFinite(row.value))).toBe(true);
	});

	it("perf analytics treats a missing memberCount as no-data (no throw on missing medians)", () => {
		// memberCount NaN must NOT slip past the guard into a body that indexes a
		// missing dimensionMedians (the original P2 throw/NaN).
		const aggNaN = { periodStart: "2026-05-07T00:00:00.000Z", memberCount: Number.NaN } as unknown as PerfWorkspaceAggregate;
		const perf = buildPerfAnalytics(aggNaN);
		expect(perf.hasData).toBe(false);
		expect(perf.memberCount).toBe(0);
		expect(perf.dimensionRows).toEqual([]);
	});

	it("perf analytics renders 0 dimensions/ROI when medians+roi are missing or NaN", () => {
		const agg = {
			workspaceId: "ws-1",
			periodStart: "2026-05-07T00:00:00.000Z",
			memberCount: 2,
			medianComposite: Number.NaN,
			// dimensionMedians + roi entirely missing on this partial payload.
		} as unknown as PerfWorkspaceAggregate;
		const perf = buildPerfAnalytics(agg);
		expect(perf.hasData).toBe(true);
		expect(perf.memberCount).toBe(2);
		expect(perf.medianComposite).toBe(0);
		expect(perf.dimensionRows).toHaveLength(5);
		for (const row of perf.dimensionRows) {
			expect(row.value).toBe(0);
			expect(Number.isNaN(row.value)).toBe(false);
		}
		expect(perf.roiTimeSavedHours).toBe(0);
		expect(perf.roiMoneySavedUsd).toBe(0);
		expect(perf.roiTmHits).toBe(0);
		expect(perf.roiAiCaughtIssues).toBe(0);
	});

	it("perf analytics clamps partial/negative dimension medians + ROI", () => {
		const agg = {
			workspaceId: "ws-1",
			periodStart: "2026-05-07T00:00:00.000Z",
			memberCount: 1,
			medianComposite: 55.55,
			dimensionMedians: { throughput: 80, quality: Number.NaN, consistency: -10 } as unknown as Record<string, number>,
			roi: { tmHits: -1, aiCaughtIssues: Number.NaN, timeSavedHours: 2.5, moneySavedUsd: Number.POSITIVE_INFINITY } as unknown,
		} as unknown as PerfWorkspaceAggregate;
		const perf = buildPerfAnalytics(agg);
		const byId = Object.fromEntries(perf.dimensionRows.map((row) => [row.id, row.value]));
		expect(byId.throughput).toBe(80);
		expect(byId.quality).toBe(0);
		expect(byId.consistency).toBe(0);
		// Dimensions absent from the payload still render at an honest 0.
		expect(byId.ai_leverage).toBe(0);
		expect(byId.collaboration).toBe(0);
		expect(perf.roiTmHits).toBe(0);
		expect(perf.roiAiCaughtIssues).toBe(0);
		expect(perf.roiTimeSavedHours).toBe(2.5);
		expect(perf.roiMoneySavedUsd).toBe(0);
		expect(Number.isFinite(perf.medianComposite)).toBe(true);
	});
});
