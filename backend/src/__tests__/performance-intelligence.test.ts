import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { v4 as uuid } from "uuid";
import {
	bayesianShrink,
	buildBaselineComparison,
	clampScore,
	compositeScore,
	computeMemberScores,
	computeRoi,
	DIMENSION_WEIGHTS,
	EWMA_ALPHA,
	ewma,
	FilePerformanceMetricsStore,
	getMemberPerformance,
	getRoi,
	getRoiWithWindow,
	getWorkspaceAggregate,
	HOURLY_RATE_USD,
	isKnownPerfRole,
	isKnownWorkEventType,
	median,
	PERF_DIMENSIONS,
	percentileBands,
	percentileRank,
	rawDimensionScore,
	ROLE_BASELINES,
	roleBaseline,
	safeRatio,
	SHRINKAGE_PRIOR_WEIGHT,
	WEEK_MS,
	type PerfDimension,
	type PerfRole,
	type PerfWorkEventType,
	type WorkEventInput,
} from "../services/performance-intelligence.js";
import {
	roleHasPermission,
	WorkspaceAccessError,
	type WorkspaceAccessStore,
	type WorkspaceMemberRecord,
	type WorkspacePermission,
	type WorkspaceRole,
} from "../services/workspace-access.js";

const tempDirs: string[] = [];

function createStore(windowEventLimit?: number): FilePerformanceMetricsStore {
	const directory = mkdtempSync(join(tmpdir(), "manga-perf-intel-"));
	tempDirs.push(directory);
	const path = join(directory, "performance-metrics.json");
	return windowEventLimit === undefined
		? new FilePerformanceMetricsStore(path)
		: new FilePerformanceMetricsStore(path, windowEventLimit);
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

const NOW = Date.parse("2026-06-02T00:00:00.000Z");

function event(overrides: Partial<WorkEventInput> & { eventType: PerfWorkEventType }): WorkEventInput {
	return {
		workspaceId: "ws-1",
		userId: "user-1",
		role: "translator",
		complexityWeight: 1,
		createdAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
		...overrides,
	};
}

// ── Pure math ──────────────────────────────────────────────────────────────────

describe("performance intelligence: scoring math", () => {
	test("clampScore bounds to [0,100] and guards non-finite", () => {
		expect(clampScore(-5)).toBe(0);
		expect(clampScore(150)).toBe(100);
		expect(clampScore(42.005)).toBe(42.01);
		expect(clampScore(Number.NaN)).toBe(0);
		expect(clampScore(Infinity)).toBe(0);
	});

	test("safeRatio never divides by zero", () => {
		expect(safeRatio(10, 0)).toBe(0);
		expect(safeRatio(10, 0, 50)).toBe(50);
		expect(safeRatio(10, 2)).toBe(5);
		expect(safeRatio(Number.NaN, 2)).toBe(0);
	});

	test("EWMA with alpha=0.3 weights the latest period more", () => {
		// s0 = 50; s1 = 0.3*80 + 0.7*50 = 59; s2 = 0.3*20 + 0.7*59 = 47.3
		const result = ewma([50, 80, 20], EWMA_ALPHA);
		expect(result).toBeCloseTo(47.3, 5);
		// single value returns itself; empty returns 0
		expect(ewma([72])).toBe(72);
		expect(ewma([])).toBe(0);
	});

	test("Bayesian shrinkage pulls low-n scores toward the prior", () => {
		// raw=100, prior=60, K=8. n=1 → (1*100 + 8*60)/9 = 64.44 (heavily shrunk)
		expect(bayesianShrink(100, 1, 60, 8)).toBeCloseTo((100 + 480) / 9, 5);
		// n=100 → barely shrunk, near 100
		expect(bayesianShrink(100, 100, 60, 8)).toBeGreaterThan(96);
		// n=0 → equals the prior exactly
		expect(bayesianShrink(100, 0, 60, 8)).toBe(60);
		// default prior weight constant is exposed and used
		expect(SHRINKAGE_PRIOR_WEIGHT).toBe(8);
	});

	test("median handles even/odd/empty", () => {
		expect(median([])).toBe(0);
		expect(median([5])).toBe(5);
		expect(median([1, 3])).toBe(2);
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
	});

	test("percentileRank positions a value and defaults empty population to median", () => {
		expect(percentileRank(50, [])).toBe(50);
		// value above all → 100, below all → 0
		expect(percentileRank(100, [10, 20, 30])).toBe(100);
		expect(percentileRank(5, [10, 20, 30])).toBe(0);
		// value equal to median of {10,20,30}
		expect(percentileRank(20, [10, 20, 30])).toBeCloseTo(50, 5);
	});

	test("percentile bands compute p50/p75/p90", () => {
		const population = Array.from({ length: 11 }, (_, i) => i * 10); // 0..100
		const bands = percentileBands(population);
		expect(bands.p50).toBeCloseTo(50, 5);
		expect(bands.p75).toBeCloseTo(75, 5);
		expect(bands.p90).toBeCloseTo(90, 5);
		const empty = percentileBands([]);
		expect(empty).toEqual({ p50: 0, p75: 0, p90: 0 });
	});

	test("composite uses the locked 25/35/15/10/15 weights", () => {
		expect(DIMENSION_WEIGHTS).toEqual({ throughput: 25, quality: 35, consistency: 15, ai_leverage: 10, collaboration: 15 });
		const dims = {
			throughput: { score: 100 },
			quality: { score: 0 },
			consistency: { score: 0 },
			ai_leverage: { score: 0 },
			collaboration: { score: 0 },
		};
		// only throughput non-zero: 100*25/100 = 25
		expect(compositeScore(dims)).toBeCloseTo(25, 5);
	});
});

// ── Dimension math ──────────────────────────────────────────────────────────────

describe("performance intelligence: dimension scores", () => {
	test("throughput is complexity-adjusted pages/hr normalized to baseline=60", () => {
		// translator normal = 3 pg/hr → 60. 1 hour, 3 complexity-pages → 60.
		const counts = aggregate([
			event({ eventType: "page_submitted", complexityWeight: 1, durationMs: 20 * 60 * 1000 }),
			event({ eventType: "page_submitted", complexityWeight: 1, durationMs: 20 * 60 * 1000 }),
			event({ eventType: "page_submitted", complexityWeight: 1, durationMs: 20 * 60 * 1000 }),
		]);
		// 3 complexity-pages in 60 min total → 3 pg/hr → ratio 1 → 60
		const score = rawDimensionScore("throughput", counts, "translator");
		expect(score).toBeCloseTo(60, 1);
	});

	test("throughput rewards higher complexity-adjusted rate", () => {
		const counts = aggregate([
			event({ eventType: "page_submitted", complexityWeight: 2, durationMs: 30 * 60 * 1000 }),
			event({ eventType: "page_submitted", complexityWeight: 2, durationMs: 30 * 60 * 1000 }),
			event({ eventType: "page_submitted", complexityWeight: 2, durationMs: 30 * 60 * 1000 }),
		]);
		// 6 complexity-pages in 90 min = 4 pg/hr → ratio 4/3 → 80
		expect(rawDimensionScore("throughput", counts, "translator")).toBeCloseTo(80, 0);
	});

	test("throughput falls back to baseline when no duration signal (no surveilled timer)", () => {
		const counts = aggregate([event({ eventType: "page_submitted" })]);
		expect(rawDimensionScore("throughput", counts, "translator")).toBe(roleBaseline("translator").dimensionBaseline.throughput);
	});

	test("untimed pages do not inflate the timed-only throughput rate", () => {
		// 9 untimed pages + 1 timed page (20 min). The rate must reflect only the
		// timed page (1 page / (1/3) hr = 3 pg/hr → 60), NOT all 10 pages in 20 min.
		const counts = aggregate([
			...times(9, () => event({ eventType: "page_submitted" })),
			event({ eventType: "page_submitted", complexityWeight: 1, durationMs: 20 * 60 * 1000 }),
		]);
		// 1 complexity-page in 20 min → 3 pg/hr → ratio 1 → 60 (not ~600 from 10 pages)
		expect(rawDimensionScore("throughput", counts, "translator")).toBeCloseTo(60, 0);
	});

	test("quality is the inverse of the rework rate, divide-by-zero safe", () => {
		// 10 submitted, 2 rejected → rework 0.2 → 80
		const counts = aggregate([
			...times(10, () => event({ eventType: "page_submitted" })),
			...times(2, () => event({ eventType: "qc_rejected" })),
		]);
		expect(rawDimensionScore("quality", counts, "translator")).toBeCloseTo(80, 5);
		// no submissions → baseline (no divide by zero)
		const none = aggregate([event({ eventType: "qc_rejected" })]);
		expect(rawDimensionScore("quality", none, "translator")).toBe(roleBaseline("translator").dimensionBaseline.quality);
	});

	test("consistency blends TM/glossary reuse and glossary adherence", () => {
		// 2 pages, 4 reuse hits (2 tm + 2 glossary) → reuseSignal = 4/(2*2)=1.0
		// adherence = 2 glossary hits / (2 hits + 0 miss) = 1.0 → blended 1.0 → 100
		const counts = aggregate([
			...times(2, () => event({ eventType: "page_submitted" })),
			...times(2, () => event({ eventType: "tm_hit" })),
			...times(2, () => event({ eventType: "glossary_hit" })),
		]);
		expect(rawDimensionScore("consistency", counts, "translator")).toBeCloseTo(100, 0);
		// glossary misses drag adherence down
		const withMiss = aggregate([
			...times(2, () => event({ eventType: "page_submitted" })),
			...times(1, () => event({ eventType: "glossary_hit" })),
			...times(1, () => event({ eventType: "glossary_miss" })),
		]);
		expect(rawDimensionScore("consistency", withMiss, "translator")).toBeLessThan(100);
	});

	test("ai_leverage = accept-rate minus post-accept-edit-rate", () => {
		// 8 accepted, 2 edited, 0 rejected → acceptRate 1.0; editRate 2/10=0.2 → 0.8 → 80
		const counts = aggregate([
			...times(8, () => event({ eventType: "ai_suggestion_accepted" })),
			...times(2, () => event({ eventType: "ai_suggestion_edited" })),
		]);
		expect(rawDimensionScore("ai_leverage", counts, "translator")).toBeCloseTo(80, 5);
		// no suggestions → baseline, no divide by zero
		const none = aggregate([event({ eventType: "page_submitted" })]);
		expect(rawDimensionScore("ai_leverage", none, "translator")).toBe(roleBaseline("translator").dimensionBaseline.ai_leverage);
	});

	test("collaboration blends resolve ratio and handoff smoothness", () => {
		// 5 opened, 4 resolved → resolveRatio 4/5 = 0.8; fast handoff (10 min) → 1.0.
		// Denominator is the opened population (max(opened, resolved)), NOT
		// opened+resolved, so the normal open-then-resolve flow is not double-counted.
		const counts = aggregate([
			...times(5, () => event({ eventType: "comment_opened" })),
			...times(4, () => event({ eventType: "comment_resolved" })),
			event({ eventType: "lock_handoff", metadata: { handoffLatencyMs: 10 * 60 * 1000 } }),
		]);
		// blended (0.8 + 1.0)/2 = 0.9 → 90
		expect(rawDimensionScore("collaboration", counts, "translator")).toBeCloseTo(90, 0);
		// no signal → baseline
		const none = aggregate([event({ eventType: "page_submitted" })]);
		expect(rawDimensionScore("collaboration", none, "translator")).toBe(roleBaseline("translator").dimensionBaseline.collaboration);
	});

	test("a fully-resolved comment set scores 100% (no opened+resolved double-count)", () => {
		// Normal lifecycle: every opened comment is also resolved. The old
		// resolved/(opened+resolved) formula would cap this at 50%; the corrected
		// resolved/opened-population yields a perfect resolve ratio.
		const counts = aggregate([
			...times(6, () => event({ eventType: "comment_opened" })),
			...times(6, () => event({ eventType: "comment_resolved" })),
		]);
		expect(rawDimensionScore("collaboration", counts, "translator")).toBeCloseTo(100, 0);
	});
});

// ── Role baselines (smart defaults) ──────────────────────────────────────────────

describe("performance intelligence: role baselines", () => {
	test("smart default normal pages/hr per role", () => {
		expect(ROLE_BASELINES.translator.normalPagesPerHour).toBe(3);
		expect(ROLE_BASELINES.cleaner.normalPagesPerHour).toBe(6);
		expect(ROLE_BASELINES.typesetter.normalPagesPerHour).toBe(4);
		expect(ROLE_BASELINES.qc.normalPagesPerHour).toBe(10);
	});

	test("unknown role validators", () => {
		expect(isKnownPerfRole("translator")).toBe(true);
		expect(isKnownPerfRole("ceo")).toBe(false);
		expect(isKnownWorkEventType("page_submitted")).toBe(true);
		expect(isKnownWorkEventType("mouse_move")).toBe(false);
	});
});

// ── Member scores: EWMA + Bayesian end-to-end ────────────────────────────────────

describe("performance intelligence: computeMemberScores", () => {
	test("low-n scores are shrunk toward baseline; all dims in [0,100]", () => {
		const events = [
			normalize(event({ eventType: "page_submitted", durationMs: 20 * 60 * 1000 })),
			normalize(event({ eventType: "page_submitted", durationMs: 20 * 60 * 1000 })),
			normalize(event({ eventType: "page_submitted", durationMs: 20 * 60 * 1000 })),
		];
		const result = computeMemberScores(events, { workspaceId: "ws-1", userId: "user-1", role: "translator", now: NOW });
		for (const dimension of PERF_DIMENSIONS) {
			expect(result.dimensions[dimension].score).toBeGreaterThanOrEqual(0);
			expect(result.dimensions[dimension].score).toBeLessThanOrEqual(100);
		}
		expect(result.composite).toBeGreaterThanOrEqual(0);
		expect(result.composite).toBeLessThanOrEqual(100);
		expect(result.sampleSize).toBe(3);
		// With only 3 samples, throughput is pulled toward baseline (60) from raw 60
		expect(result.dimensions.throughput.score).toBeCloseTo(60, 0);
	});

	test("more events reduce shrinkage so the score tracks the raw signal", () => {
		// Many high-quality submissions: raw quality near 100, large n → close to 100.
		const events = times(40, () => normalize(event({ eventType: "page_submitted" })));
		const result = computeMemberScores(events, { workspaceId: "ws-1", userId: "user-1", role: "translator", now: NOW });
		// raw quality = 100 (no rejects), n=40 vs prior 70 → strongly toward 100
		expect(result.dimensions.quality.score).toBeGreaterThan(90);
	});

	test("EWMA across an improving 4-week trend tracks the recent uptrend", () => {
		// Quality improves each week: w1 50% rework, w2 30%, w3 10%, w4 0%.
		const buckets: Array<{ week: number; submitted: number; rejected: number }> = [
			{ week: 3, submitted: 10, rejected: 5 },
			{ week: 2, submitted: 10, rejected: 3 },
			{ week: 1, submitted: 10, rejected: 1 },
			{ week: 0, submitted: 10, rejected: 0 },
		];
		const events = buckets.flatMap(({ week, submitted, rejected }) => {
			const at = new Date(NOW - week * WEEK_MS - 1000).toISOString();
			return [
				...times(submitted, () => normalize(event({ eventType: "page_submitted", createdAt: at }))),
				...times(rejected, () => normalize(event({ eventType: "qc_rejected", createdAt: at }))),
			];
		});
		const result = computeMemberScores(events, { workspaceId: "ws-1", userId: "user-1", role: "translator", now: NOW });
		// Raw per-week quality (oldest→newest): 50, 70, 90, 100.
		// EWMA(α=0.3): s0=50, s1=56, s2=66.2, s3=76.34.
		const expectedEwma = ewma([50, 70, 90, 100], EWMA_ALPHA);
		expect(expectedEwma).toBeCloseTo(76.34, 2);
		// Then Bayesian shrinkage toward the role quality baseline (70) using the
		// member's actual total sample size for this window.
		const shrunk = bayesianShrink(expectedEwma, result.sampleSize, roleBaseline("translator").dimensionBaseline.quality);
		expect(result.dimensions.quality.score).toBeCloseTo(clampScore(shrunk), 1);
		// Sanity: a smoothed, shrunk score sits between the worst week and the best.
		expect(result.dimensions.quality.score).toBeGreaterThan(50);
		expect(result.dimensions.quality.score).toBeLessThan(100);
	});

	test("zero events yields baseline scores with no NaN", () => {
		const result = computeMemberScores([], { workspaceId: "ws-1", userId: "ghost", role: "qc", now: NOW });
		expect(result.sampleSize).toBe(0);
		expect(Number.isFinite(result.composite)).toBe(true);
		expect(result.dimensions.quality.score).toBe(roleBaseline("qc").dimensionBaseline.quality);
	});
});

// ── Baselines / comparisons ───────────────────────────────────────────────────────

describe("performance intelligence: baseline comparisons", () => {
	test("vs-self delta is null when there is no prior window", () => {
		const cmp = buildBaselineComparison({ composite: 70, selfPreviousComposite: null, workspaceComposites: [60, 80], platformComposites: null });
		expect(cmp.vsSelf.delta).toBeNull();
		expect(cmp.vsWorkspace.median).toBe(70);
		expect(cmp.vsWorkspace.delta).toBe(0);
		expect(cmp.vsPlatform).toBeNull();
	});

	test("vs-self, vs-workspace, vs-platform are all computed when data present", () => {
		const cmp = buildBaselineComparison({
			composite: 80,
			selfPreviousComposite: 70,
			workspaceComposites: [60, 70, 90],
			platformComposites: [50, 60, 70, 80, 90],
		});
		expect(cmp.vsSelf.delta).toBeCloseTo(10, 5);
		expect(cmp.vsWorkspace.median).toBe(70);
		expect(cmp.vsWorkspace.delta).toBeCloseTo(10, 5);
		expect(cmp.vsPlatform).not.toBeNull();
		expect(cmp.vsPlatform?.percentile).toBeGreaterThan(50);
		// p90 of {50,60,70,80,90} with linear interpolation: rank 0.9*4=3.6 → 80+0.6*10=86
		expect(cmp.vsPlatform?.bands.p90).toBeCloseTo(86, 5);
		expect(cmp.vsPlatform?.bands.p50).toBeCloseTo(70, 5);
	});
});

// ── ROI ──────────────────────────────────────────────────────────────────────────

describe("performance intelligence: ROI", () => {
	test("time and money saved derive from TM hits and AI-caught issues", () => {
		const events = [
			...times(10, () => normalize(event({ eventType: "tm_hit", role: "translator" }))),
			...times(4, () => normalize(event({ eventType: "ai_suggestion_accepted", role: "translator" }))),
			...times(2, () => normalize(event({ eventType: "ai_suggestion_edited", role: "translator" }))),
		];
		const roi = computeRoi(events);
		expect(roi.tmHits).toBe(10);
		expect(roi.aiCaughtIssues).toBe(6);
		// translator avgRetype = 1.5 min. tm: 10*1.5=15; ai accepted 4*1.5=6; edited 2*0.75=1.5
		const expectedMinutes = 10 * 1.5 + 4 * 1.5 + 2 * 1.5 * 0.5;
		expect(roi.timeSavedMinutes).toBeCloseTo(expectedMinutes, 5);
		expect(roi.moneySavedUsd).toBeCloseTo((expectedMinutes / 60) * HOURLY_RATE_USD, 2);
		expect(roi.hourlyRateUsd).toBe(20);
	});

	test("empty events → zero ROI, no NaN", () => {
		const roi = computeRoi([]);
		expect(roi.timeSavedMinutes).toBe(0);
		expect(roi.moneySavedUsd).toBe(0);
	});
});

// ── Store: file fallback + workspace isolation ─────────────────────────────────────

describe("performance intelligence: file store + isolation", () => {
	test("records and lists events scoped by workspace, ordered oldest-first", async () => {
		const store = createStore();
		await store.recordEvent(event({ workspaceId: "ws-1", userId: "user-1", eventType: "page_submitted", createdAt: new Date(NOW - 2000).toISOString() }));
		await store.recordEvent(event({ workspaceId: "ws-1", userId: "user-2", eventType: "page_submitted", createdAt: new Date(NOW - 1000).toISOString() }));
		await store.recordEvent(event({ workspaceId: "ws-2", userId: "user-3", eventType: "page_submitted", createdAt: new Date(NOW).toISOString() }));

		const ws1 = await store.listEvents({ workspaceId: "ws-1" });
		expect(ws1).toHaveLength(2);
		expect(ws1.every((e) => e.workspaceId === "ws-1")).toBe(true);

		// Cross-workspace data never leaks.
		const ws2 = await store.listEvents({ workspaceId: "ws-2" });
		expect(ws2).toHaveLength(1);
		expect(ws2[0]?.userId).toBe("user-3");

		const userScoped = await store.listEvents({ workspaceId: "ws-1", userId: "user-1" });
		expect(userScoped).toHaveLength(1);

		const userIds = await store.listWorkspaceUserIds("ws-1");
		expect(userIds.sort()).toEqual(["user-1", "user-2"]);
	});

	test("listEvents applies LIMIT and keyset cursors with createdAt/id tie-breaks", async () => {
		const store = createStore();
		const old = "2026-05-30T00:00:00.000Z";
		const same = "2026-05-31T00:00:00.000Z";
		const newest = "2026-06-01T00:00:00.000Z";
		await store.recordEvent(event({ id: "a-old", workspaceId: "ws-1", userId: "user-1", eventType: "page_submitted", createdAt: old }));
		await store.recordEvent(event({ id: "b-same", workspaceId: "ws-1", userId: "user-1", eventType: "tm_hit", createdAt: same }));
		await store.recordEvent(event({ id: "c-same", workspaceId: "ws-1", userId: "user-1", eventType: "glossary_hit", createdAt: same }));
		await store.recordEvent(event({ id: "d-newest", workspaceId: "ws-1", userId: "user-1", eventType: "ai_suggestion_accepted", createdAt: newest }));
		await store.recordEvent(event({ id: "z-noise", workspaceId: "ws-2", userId: "user-2", eventType: "tm_hit", createdAt: newest }));

		const firstPage = await store.listEvents({ workspaceId: "ws-1", order: "desc", limit: 2 });
		expect(firstPage.map((e) => e.id)).toEqual(["d-newest", "c-same"]);

		const olderPage = await store.listEvents({
			workspaceId: "ws-1",
			order: "desc",
			limit: 2,
			before: { createdAt: same, id: "c-same" },
		});
		expect(olderPage.map((e) => e.id)).toEqual(["b-same", "a-old"]);

		const newerAscending = await store.listEvents({
			workspaceId: "ws-1",
			order: "asc",
			limit: 2,
			after: { createdAt: same, id: "b-same" },
		});
		expect(newerAscending.map((e) => e.id)).toEqual(["c-same", "d-newest"]);
		expect(newerAscending.every((e) => e.workspaceId === "ws-1")).toBe(true);
	});

	test("persists across reload and normalizes invalid complexity weight", async () => {
		const directory = mkdtempSync(join(tmpdir(), "manga-perf-reload-"));
		tempDirs.push(directory);
		const path = join(directory, "performance-metrics.json");
		const store = new FilePerformanceMetricsStore(path);
		const recorded = await store.recordEvent(event({ eventType: "page_submitted", complexityWeight: -5 }));
		expect(recorded.complexityWeight).toBe(1); // negative normalized to default

		const reloaded = new FilePerformanceMetricsStore(path);
		const events = await reloaded.listEvents({ workspaceId: "ws-1" });
		expect(events).toHaveLength(1);
		expect(events[0]?.id).toBe(recorded.id);
	});

	test("getWorkspaceAggregate returns medians + ROI without leaking another workspace", async () => {
		const store = createStore();
		// ws-1 members
		for (const userId of ["a", "b"]) {
			await store.recordEvent(event({ workspaceId: "ws-1", userId, eventType: "page_submitted", createdAt: new Date(NOW - 1000).toISOString() }));
			await store.recordEvent(event({ workspaceId: "ws-1", userId, eventType: "tm_hit", createdAt: new Date(NOW - 1000).toISOString() }));
		}
		// ws-2 noise
		await store.recordEvent(event({ workspaceId: "ws-2", userId: "z", eventType: "tm_hit", createdAt: new Date(NOW - 1000).toISOString() }));

		const aggregate = await getWorkspaceAggregate({ workspaceId: "ws-1", now: NOW }, store);
		expect(aggregate.memberCount).toBe(2);
		expect(aggregate.roi.tmHits).toBe(2); // only ws-1 TM hits
		expect(aggregate.medianComposite).toBeGreaterThanOrEqual(0);
		expect(aggregate.medianComposite).toBeLessThanOrEqual(100);
	});

	test("getMemberPerformance computes self vs workspace baseline from store", async () => {
		const store = createStore();
		const recent = new Date(NOW - 1000).toISOString();
		for (const userId of ["self", "peer"]) {
			await store.recordEvent(event({ workspaceId: "ws-1", userId, eventType: "page_submitted", createdAt: recent }));
		}
		const result = await getMemberPerformance({ workspaceId: "ws-1", userId: "self", now: NOW }, store);
		expect(result.scores.userId).toBe("self");
		expect(result.baseline.vsWorkspace.median).toBeGreaterThanOrEqual(0);
		// no platform percentile unless explicitly opted in
		expect(result.baseline.vsPlatform).toBeNull();
		expect(result.roi).toBeDefined();
	});

	test("getRoi scopes to a member or the whole workspace", async () => {
		const store = createStore();
		const recent = new Date(NOW - 1000).toISOString();
		await store.recordEvent(event({ workspaceId: "ws-1", userId: "u1", eventType: "tm_hit", createdAt: recent }));
		await store.recordEvent(event({ workspaceId: "ws-1", userId: "u2", eventType: "tm_hit", createdAt: recent }));

		const mineOnly = await getRoi({ workspaceId: "ws-1", userId: "u1", now: NOW }, store);
		expect(mineOnly.tmHits).toBe(1);
		const wholeWorkspace = await getRoi({ workspaceId: "ws-1", now: NOW }, store);
		expect(wholeWorkspace.tmHits).toBe(2);
	});

	test("member and ROI aggregation cap to the newest events and surface truncation metadata", async () => {
		const store = createStore(2);
		const oldA = new Date(NOW - 6 * 24 * 60 * 60 * 1000).toISOString();
		const oldB = new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString();
		const newestA = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();
		const newestB = new Date(NOW - 1 * 24 * 60 * 60 * 1000).toISOString();
		await store.recordEvent(event({ id: "old-a", workspaceId: "ws-1", userId: "self", eventType: "tm_hit", createdAt: oldA }));
		await store.recordEvent(event({ id: "old-b", workspaceId: "ws-1", userId: "self", eventType: "tm_hit", createdAt: oldB }));
		await store.recordEvent(event({ id: "new-a", workspaceId: "ws-1", userId: "self", eventType: "ai_suggestion_accepted", createdAt: newestA }));
		await store.recordEvent(event({ id: "new-b", workspaceId: "ws-1", userId: "self", eventType: "page_submitted", createdAt: newestB }));

		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			const profile = await getMemberPerformance({ workspaceId: "ws-1", userId: "self", now: NOW }, store);
			expect(profile.windowTruncated).toBe(true);
			expect(profile.previousWindowTruncated).toBe(false);
			expect(profile.workspaceBaselineTruncated).toBe(true);
			expect(profile.windowEventLimit).toBe(2);
			expect(profile.scores.sampleSize).toBe(2);
			// Only the newest two events feed current-window ROI; old TM hits are
			// intentionally absent from the capped payload.
			expect(profile.roi.tmHits).toBe(0);
			expect(profile.roi.aiCaughtIssues).toBe(1);

			const roiWindow = await getRoiWithWindow({ workspaceId: "ws-1", userId: "self", now: NOW }, store);
			expect(roiWindow.windowTruncated).toBe(true);
			expect(roiWindow.windowEventLimit).toBe(2);
			expect(roiWindow.roi.tmHits).toBe(0);
			expect(roiWindow.roi.aiCaughtIssues).toBe(1);
		} finally {
			console.warn = originalWarn;
		}
	});
});

// ── rank8: dashboard grouped-read (parity + query-count) ────────────────────────────

import type {
	PerformanceMetricsStore,
	WorkEvent,
	WorkEventQuery,
	WorkspaceWindowEvents,
} from "../services/performance-intelligence.js";

// Counting store that exposes the optimized grouped read. It wraps a
// FilePerformanceMetricsStore for the actual data and tallies every read so a
// test can assert the perf dashboard issues ONE grouped query rather than a
// per-member listEvents loop + a duplicate full-window refetch.
class CountingPerfStore implements PerformanceMetricsStore {
	listEventsCalls = 0;
	listWorkspaceUserIdsCalls = 0;
	listWorkspaceWindowEventsCalls = 0;

	constructor(private readonly inner: FilePerformanceMetricsStore) {}

	recordEvent(input: WorkEventInput) {
		return this.inner.recordEvent(input);
	}
	listEvents(query: WorkEventQuery) {
		this.listEventsCalls += 1;
		return this.inner.listEvents(query);
	}
	listWorkspaceUserIds(workspaceId: string) {
		this.listWorkspaceUserIdsCalls += 1;
		return this.inner.listWorkspaceUserIds(workspaceId);
	}
	listWorkspaceWindowEvents(query: { workspaceId: string; since?: number; until?: number }) {
		this.listWorkspaceWindowEventsCalls += 1;
		return this.inner.listWorkspaceWindowEvents(query);
	}
}

// Same store but WITHOUT the grouped read, so the service must fall back to the
// legacy per-member loop (the pre-fix N+1 + duplicate refetch). Used as the
// parity oracle and to demonstrate the query-count delta.
class LegacyCountingPerfStore implements PerformanceMetricsStore {
	listEventsCalls = 0;
	listWorkspaceUserIdsCalls = 0;

	constructor(private readonly inner: FilePerformanceMetricsStore) {}

	recordEvent(input: WorkEventInput) {
		return this.inner.recordEvent(input);
	}
	listEvents(query: WorkEventQuery): Promise<WorkEvent[]> {
		this.listEventsCalls += 1;
		return this.inner.listEvents(query);
	}
	listWorkspaceUserIds(workspaceId: string) {
		this.listWorkspaceUserIdsCalls += 1;
		return this.inner.listWorkspaceUserIds(workspaceId);
	}
	// Intentionally no listWorkspaceWindowEvents — forces the fallback path.
}

async function seedMultiMemberWorkspace(store: PerformanceMetricsStore): Promise<void> {
	const recent = new Date(NOW - 60 * 60 * 1000).toISOString();
	const older = new Date(NOW - 9 * 24 * 60 * 60 * 1000).toISOString(); // ~prev week bucket
	// 3 members in ws-1 with a mix of event types + durations across 2 weeks,
	// plus a second-workspace member that must never leak into ws-1 numbers.
	const members: Array<{ userId: string; role: PerfRole }> = [
		{ userId: "alice", role: "translator" },
		{ userId: "bob", role: "qc" },
		{ userId: "carol", role: "cleaner" },
	];
	for (const { userId, role } of members) {
		await store.recordEvent(event({ workspaceId: "ws-1", userId, role, eventType: "page_submitted", durationMs: 1_800_000, complexityWeight: 2, createdAt: recent }));
		await store.recordEvent(event({ workspaceId: "ws-1", userId, role, eventType: "page_submitted", durationMs: 1_200_000, createdAt: older }));
		await store.recordEvent(event({ workspaceId: "ws-1", userId, role, eventType: "tm_hit", createdAt: recent }));
		await store.recordEvent(event({ workspaceId: "ws-1", userId, role, eventType: "ai_suggestion_accepted", createdAt: recent }));
		await store.recordEvent(event({ workspaceId: "ws-1", userId, role, eventType: "qc_rejected", createdAt: older }));
	}
	await store.recordEvent(event({ workspaceId: "ws-2", userId: "zed", eventType: "tm_hit", createdAt: recent }));
}

describe("performance intelligence: rank8 grouped dashboard read", () => {
	test("groupWorkspaceWindowEvents partitions by user and preserves all-events list", async () => {
		const store = createStore();
		await seedMultiMemberWorkspace(store);
		const windowStart = NOW - 4 * WEEK_MS;
		const grouped = await store.listWorkspaceWindowEvents({ workspaceId: "ws-1", since: windowStart, until: NOW });
		// 3 ws-1 members grouped; ws-2 excluded.
		expect([...grouped.byUser.keys()].sort()).toEqual(["alice", "bob", "carol"]);
		// `all` is the flat list (reused for ROI) and equals the sum of the groups.
		const groupedTotal = [...grouped.byUser.values()].reduce((n, list) => n + list.length, 0);
		expect(grouped.all.length).toBe(groupedTotal);
		expect(grouped.all.every((e) => e.workspaceId === "ws-1")).toBe(true);
	});

	test("getWorkspaceAggregate metric parity: grouped read equals legacy per-member loop", async () => {
		const optimized = new CountingPerfStore(createStore());
		const legacy = new LegacyCountingPerfStore(createStore());
		await seedMultiMemberWorkspace(optimized);
		await seedMultiMemberWorkspace(legacy);

		const fast = await getWorkspaceAggregate({ workspaceId: "ws-1", now: NOW }, optimized);
		const slow = await getWorkspaceAggregate({ workspaceId: "ws-1", now: NOW }, legacy);

		// Byte-for-byte identical dashboard numbers.
		expect(fast).toEqual(slow);
		expect(fast.memberCount).toBe(3);
		expect(fast.roi.tmHits).toBe(3); // 3 ws-1 members, one TM hit each; ws-2 excluded
	});

	test("getMemberPerformance metric parity: grouped read equals legacy per-member loop", async () => {
		const optimized = new CountingPerfStore(createStore());
		const legacy = new LegacyCountingPerfStore(createStore());
		await seedMultiMemberWorkspace(optimized);
		await seedMultiMemberWorkspace(legacy);

		const fast = await getMemberPerformance({ workspaceId: "ws-1", userId: "alice", now: NOW }, optimized);
		const slow = await getMemberPerformance({ workspaceId: "ws-1", userId: "alice", now: NOW }, legacy);

		expect(fast).toEqual(slow);
		expect(fast.scores.userId).toBe("alice");
	});

	test("getWorkspaceAggregate issues ONE grouped read, not a per-member loop + duplicate refetch", async () => {
		const optimized = new CountingPerfStore(createStore());
		const legacy = new LegacyCountingPerfStore(createStore());
		await seedMultiMemberWorkspace(optimized);
		await seedMultiMemberWorkspace(legacy);

		await getWorkspaceAggregate({ workspaceId: "ws-1", now: NOW }, optimized);
		await getWorkspaceAggregate({ workspaceId: "ws-1", now: NOW }, legacy);

		// Optimized: exactly one grouped query, zero per-member listEvents,
		// zero separate full-window refetch, no DISTINCT user_id pre-scan.
		expect(optimized.listWorkspaceWindowEventsCalls).toBe(1);
		expect(optimized.listEventsCalls).toBe(0);
		expect(optimized.listWorkspaceUserIdsCalls).toBe(0);

		// Fallback stores without the grouped API still get one bounded workspace
		// listEvents read, not a per-member loop or duplicate full-window refetch.
		expect(legacy.listWorkspaceUserIdsCalls).toBe(0);
		expect(legacy.listEventsCalls).toBe(1);
	});

	test("getMemberPerformance collapses the workspace-composite N+1 into one grouped read", async () => {
		const optimized = new CountingPerfStore(createStore());
		await seedMultiMemberWorkspace(optimized);

		await getMemberPerformance({ workspaceId: "ws-1", userId: "alice", now: NOW }, optimized);

		// Member self window + previous window = 2 direct listEvents (run in
		// parallel). The workspace-composite read is a SINGLE grouped query rather
		// than one listEvents per member.
		expect(optimized.listWorkspaceWindowEventsCalls).toBe(1);
		expect(optimized.listEventsCalls).toBe(2);
		expect(optimized.listWorkspaceUserIdsCalls).toBe(0);
	});

	test("getMemberPerformance legacy fallback uses one bounded workspace read for baselines", async () => {
		const legacy = new LegacyCountingPerfStore(createStore());
		await seedMultiMemberWorkspace(legacy);

		await getMemberPerformance({ workspaceId: "ws-1", userId: "alice", now: NOW }, legacy);

		// Current member window + previous member window + one bounded workspace
		// baseline read. No DISTINCT user_id pre-scan and no per-member fan-out.
		expect(legacy.listEventsCalls).toBe(3);
		expect(legacy.listWorkspaceUserIdsCalls).toBe(0);
	});
});

// ── Postgres store SQL shape (fake client) ─────────────────────────────────────────

import { PostgresPerformanceMetricsStore } from "../services/performance-intelligence.js";

class FakePerfSqlClient {
	queries: Array<{ query: string; params?: unknown[] }> = [];
	rows: Array<Record<string, unknown>> = [];

	async unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]> {
		this.queries.push({ query, params });
		if (query.includes("INSERT INTO work_events")) return [] as T[];
		if (query.includes("SELECT DISTINCT user_id")) {
			const ws = params?.[0];
			const ids = new Set<string>();
			for (const row of this.rows) if (row.workspace_id === ws) ids.add(String(row.user_id));
			return [...ids].map((user_id) => ({ user_id })) as T[];
		}
		const ws = params?.[0];
		const inWorkspace = this.rows.filter((row) => row.workspace_id === ws);
		const paramAt = (pattern: RegExp): unknown | undefined => {
			const match = query.match(pattern);
			if (!match?.[1]) return undefined;
			return params?.[Number(match[1]) - 1];
		};
		const tupleParams = (pattern: RegExp): [unknown, unknown] | null => {
			const match = query.match(pattern);
			if (!match?.[1] || !match?.[2]) return null;
			return [params?.[Number(match[1]) - 1], params?.[Number(match[2]) - 1]];
		};
		const ts = (row: Record<string, unknown>) => Date.parse(String(row.created_at));
		const compareTuple = (row: Record<string, unknown>, createdAt: unknown, id: unknown): number => {
			const dt = ts(row) - Date.parse(String(createdAt));
			return dt !== 0 ? dt : String(row.id).localeCompare(String(id));
		};
		// listWorkspaceWindowEvents: a windowed read that keeps only the NEWEST
		// `LIMIT + 1` rows (created_at DESC, id DESC) and re-orders them ascending.
		// We emulate the same window filter + newest-first cap so the cap/truncation
		// behavior is exercised, not just the SQL text.
		if (query.includes("FROM (") && query.includes("ORDER BY created_at DESC, id DESC") && query.includes("LIMIT")) {
			const limit = Number(params?.[params.length - 1]);
			const sinceParam = paramAt(/created_at >= \$(\d+)::timestamptz/);
			const untilParam = paramAt(/created_at <= \$(\d+)::timestamptz/);
			const since = typeof sinceParam === "string" ? Date.parse(sinceParam) : -Infinity;
			const until = typeof untilParam === "string" ? Date.parse(untilParam) : Infinity;
			const windowed = inWorkspace.filter((row) => ts(row) >= since && ts(row) <= until);
			// Newest-first, then cap, mirroring the inner subquery.
			const newestFirst = [...windowed].sort((a, b) => {
				const dt = ts(b) - ts(a);
				return dt !== 0 ? dt : String(b.id).localeCompare(String(a.id));
			});
			const kept = Number.isFinite(limit) ? newestFirst.slice(0, limit) : newestFirst;
			// Outer ORDER BY user_id ASC, created_at ASC, id ASC.
			kept.sort((a, b) => {
				const u = String(a.user_id).localeCompare(String(b.user_id));
				if (u !== 0) return u;
				const dt = ts(a) - ts(b);
				return dt !== 0 ? dt : String(a.id).localeCompare(String(b.id));
			});
			return kept as T[];
		}
		// listEvents SELECT: emulate workspace/user/window filters, keyset cursor,
		// stable created_at/id ordering, and LIMIT.
		let rows = inWorkspace;
		const userParam = paramAt(/user_id = \$(\d+)/);
		if (typeof userParam === "string") rows = rows.filter((row) => row.user_id === userParam);
		const sinceParam = paramAt(/created_at >= \$(\d+)::timestamptz/);
		if (typeof sinceParam === "string") rows = rows.filter((row) => ts(row) >= Date.parse(sinceParam));
		const untilParam = paramAt(/created_at <= \$(\d+)::timestamptz/);
		if (typeof untilParam === "string") rows = rows.filter((row) => ts(row) <= Date.parse(untilParam));
		const beforeParams = tupleParams(/\(created_at, id\) < \(\$(\d+)::timestamptz, \$(\d+)\)/);
		if (beforeParams) rows = rows.filter((row) => compareTuple(row, beforeParams[0], beforeParams[1]) < 0);
		const afterParams = tupleParams(/\(created_at, id\) > \(\$(\d+)::timestamptz, \$(\d+)\)/);
		if (afterParams) rows = rows.filter((row) => compareTuple(row, afterParams[0], afterParams[1]) > 0);
		const desc = query.includes("ORDER BY created_at DESC, id DESC");
		rows = [...rows].sort((a, b) => {
			const dt = ts(a) - ts(b);
			const ascending = dt !== 0 ? dt : String(a.id).localeCompare(String(b.id));
			return desc ? -ascending : ascending;
		});
		const limitParam = paramAt(/LIMIT \$(\d+)/);
		const limit = Number(limitParam);
		return (Number.isFinite(limit) ? rows.slice(0, limit) : rows) as T[];
	}
}

describe("performance intelligence: postgres store", () => {
	test("recordEvent inserts into work_events with scoped params", async () => {
		const client = new FakePerfSqlClient();
		const store = new PostgresPerformanceMetricsStore(client);
		const ev = await store.recordEvent(event({ eventType: "page_submitted", durationMs: 1000, projectId: "p1" }));
		const insert = client.queries.find((q) => q.query.includes("INSERT INTO work_events"));
		expect(insert).toBeDefined();
		expect(insert?.params?.[1]).toBe("ws-1"); // workspace_id
		expect(insert?.params?.[2]).toBe("user-1"); // user_id
		expect(insert?.params?.[5]).toBe("page_submitted"); // event_type
		expect(ev.id).toBeDefined();
	});

	test("listEvents maps rows and is workspace-scoped in SQL", async () => {
		const client = new FakePerfSqlClient();
		client.rows = [
			{ id: "e1", workspace_id: "ws-1", user_id: "u1", project_id: null, role: "translator", event_type: "page_submitted", complexity_weight: 1, duration_ms: null, metadata: "{}", created_at: "2026-06-01T00:00:00.000Z" },
			{ id: "e2", workspace_id: "ws-2", user_id: "u2", project_id: null, role: "qc", event_type: "qc_rejected", complexity_weight: 1, duration_ms: null, metadata: "{}", created_at: "2026-06-01T00:00:00.000Z" },
		];
		const store = new PostgresPerformanceMetricsStore(client);
		const events = await store.listEvents({ workspaceId: "ws-1" });
		expect(events).toHaveLength(1);
		expect(events[0]?.id).toBe("e1");
		const select = client.queries.find((q) => q.query.includes("FROM work_events"));
		expect(select?.query).toContain("workspace_id = $1");
	});

	test("listEvents SQL uses bounded keyset pagination, not OFFSET", async () => {
		const client = new FakePerfSqlClient();
		const same = "2026-06-01T00:00:00.000Z";
		client.rows = [
			{ id: "a-old", workspace_id: "ws-1", user_id: "u1", project_id: null, role: "translator", event_type: "page_submitted", complexity_weight: 1, duration_ms: null, metadata: "{}", created_at: "2026-05-30T00:00:00.000Z" },
			{ id: "b-same", workspace_id: "ws-1", user_id: "u1", project_id: null, role: "translator", event_type: "tm_hit", complexity_weight: 1, duration_ms: null, metadata: "{}", created_at: same },
			{ id: "c-same", workspace_id: "ws-1", user_id: "u1", project_id: null, role: "translator", event_type: "glossary_hit", complexity_weight: 1, duration_ms: null, metadata: "{}", created_at: same },
			{ id: "d-newest", workspace_id: "ws-1", user_id: "u1", project_id: null, role: "translator", event_type: "ai_suggestion_accepted", complexity_weight: 1, duration_ms: null, metadata: "{}", created_at: "2026-06-02T00:00:00.000Z" },
		];
		const store = new PostgresPerformanceMetricsStore(client);
		const page = await store.listEvents({
			workspaceId: "ws-1",
			order: "desc",
			limit: 2,
			before: { createdAt: same, id: "c-same" },
		});
		expect(page.map((e) => e.id)).toEqual(["b-same", "a-old"]);

		const select = client.queries.find((q) => q.query.includes("FROM work_events"));
		expect(select?.query).toContain("(created_at, id) < ($2::timestamptz, $3)");
		expect(select?.query).toContain("ORDER BY created_at DESC, id DESC");
		expect(select?.query).toContain("LIMIT $4");
		expect(select?.query).not.toContain("OFFSET");
		expect(select?.params).toEqual(["ws-1", same, "c-same", 2]);
	});

	test("constructor rejects empty DATABASE_URL", () => {
		expect(() => new PostgresPerformanceMetricsStore("")).toThrow();
	});

	test("listWorkspaceWindowEvents is ONE bounded, grouped-by-user query", async () => {
		const client = new FakePerfSqlClient();
		client.rows = [
			{ id: "e2", workspace_id: "ws-1", user_id: "u2", project_id: null, role: "qc", event_type: "qc_rejected", complexity_weight: 1, duration_ms: null, metadata: "{}", created_at: "2026-06-01T00:00:00.000Z" },
			{ id: "e1", workspace_id: "ws-1", user_id: "u1", project_id: null, role: "translator", event_type: "page_submitted", complexity_weight: 1, duration_ms: null, metadata: "{}", created_at: "2026-06-01T00:00:00.000Z" },
			{ id: "e3", workspace_id: "ws-2", user_id: "u3", project_id: null, role: "cleaner", event_type: "tm_hit", complexity_weight: 1, duration_ms: null, metadata: "{}", created_at: "2026-06-01T00:00:00.000Z" },
		];
		const store = new PostgresPerformanceMetricsStore(client);
		const since = Date.parse("2026-05-01T00:00:00.000Z");
		const until = Date.parse("2026-06-02T00:00:00.000Z");
		const grouped = await store.listWorkspaceWindowEvents({ workspaceId: "ws-1", since, until });

		// One query covers every member — no per-user fan-out.
		const selects = client.queries.filter((q) => q.query.includes("FROM work_events"));
		expect(selects).toHaveLength(1);
		const sql = selects[0]!.query;
		expect(sql).toContain("workspace_id = $1");
		// Bounded by the window so it is not a full-lifetime scan.
		expect(sql).toContain("created_at >= $2::timestamptz");
		expect(sql).toContain("created_at <= $3::timestamptz");
		// Defensively capped: newest-first inner select + LIMIT keeps the read bounded,
		// then the outer select re-orders ascending so each member slice is contiguous.
		expect(sql).toContain("ORDER BY created_at DESC, id DESC");
		expect(sql).toContain("LIMIT $4");
		expect(sql).toContain("ORDER BY user_id ASC, created_at ASC, id ASC");
		// The LIMIT param is the configured cap.
		const limitParam = selects[0]!.params?.[3];
		expect(typeof limitParam).toBe("number");
		expect(limitParam as number).toBeGreaterThan(0);

		// Grouped by user, cross-workspace rows excluded.
		expect([...grouped.byUser.keys()].sort()).toEqual(["u1", "u2"]);
		expect(grouped.all).toHaveLength(2);
	});

	test("LIMIT cap keeps the NEWEST window rows, logs truncation, and is transparent under the cap", async () => {
		// Fixture: one member, page_submitted events across ~3 weekly buckets, oldest
		// to newest. Under a generous cap nothing is dropped and the grouped read
		// equals the unbounded row set (so the EWMA-bucketed score is identical);
		// under a tight cap only the newest rows survive and the drop is logged.
		const mkRow = (id: string, createdAt: string) => ({
			id,
			workspace_id: "ws-1",
			user_id: "u1",
			project_id: null,
			role: "translator",
			event_type: "page_submitted",
			complexity_weight: 1,
			duration_ms: 1_000_000,
			metadata: "{}",
			created_at: createdAt,
		});
		// ids chosen so the id-tiebreak order is deterministic and unambiguous.
		const rows = [
			mkRow("a1", "2026-05-19T00:00:00.000Z"), // oldest
			mkRow("a2", "2026-05-20T00:00:00.000Z"),
			mkRow("a3", "2026-05-26T00:00:00.000Z"),
			mkRow("a4", "2026-06-01T00:00:00.000Z"),
			mkRow("a5", "2026-06-01T12:00:00.000Z"), // newest
		];
		const since = Date.parse("2026-05-12T00:00:00.000Z");
		const until = Date.parse("2026-06-02T00:00:00.000Z");

		const originalWarn = console.warn;
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
		try {
			// 1) Generous cap (1000 ≫ 5 rows): nothing dropped. The grouped output is
			// the full, ascending row set, no truncation log, and the score computed
			// from the grouped slice equals the score of the raw rows — i.e. the cap
			// path is transparent for an under-cap workspace.
			const uncappedClient = new FakePerfSqlClient();
			uncappedClient.rows = rows;
			const uncappedStore = new PostgresPerformanceMetricsStore(uncappedClient, 1000);
			const uncapped = await uncappedStore.listWorkspaceWindowEvents({ workspaceId: "ws-1", since, until });
			expect(uncapped.all.map((e) => e.id)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
			expect(warnings).toHaveLength(0);
			// Under the cap: the contract reports a complete window, not a truncation.
			expect(uncapped.truncated).toBe(false);

			const groupedScore = computeMemberScores(uncapped.byUser.get("u1")!, { workspaceId: "ws-1", userId: "u1", now: NOW });
			const directScore = computeMemberScores(rows.map(toWorkEvent), { workspaceId: "ws-1", userId: "u1", now: NOW });
			expect(groupedScore).toEqual(directScore);

			// 2) Tight cap (2): only the two NEWEST in-window rows survive (a4, a5),
			// re-ordered ascending; the oldest three are dropped and the truncation is
			// logged with the active cap so an operator can raise it.
			const cappedClient = new FakePerfSqlClient();
			cappedClient.rows = rows;
			const cappedStore = new PostgresPerformanceMetricsStore(cappedClient, 2);
			const capped = await cappedStore.listWorkspaceWindowEvents({ workspaceId: "ws-1", since, until });
			expect(capped.all.map((e) => e.id)).toEqual(["a4", "a5"]);
			expect(warnings.some((w) => w.includes("PERF_WINDOW_EVENT_LIMIT=2") && w.includes("truncated"))).toBe(true);
			// At the cap: the contract surfaces the drop so callers don't present the
			// recent-only slice as a complete-period figure.
			expect(capped.truncated).toBe(true);
		} finally {
			console.warn = originalWarn;
		}
	});

	test("truncated is true ONLY when rows exceed the cap (boundary)", async () => {
		// 3 in-window rows for one member. cap=2 fetches a sentinel row and proves
		// truncation; cap=3 is an exact fit and must NOT be reported as truncated.
		// This guards the old >= boundary bug that marked exact-fit windows as
		// recent-only even when no older row was dropped.
		const mkRow = (id: string, createdAt: string) => ({
			id, workspace_id: "ws-1", user_id: "u1", project_id: null, role: "translator",
			event_type: "page_submitted", complexity_weight: 1, duration_ms: null, metadata: "{}", created_at: createdAt,
		});
		const rows = [
			mkRow("b1", "2026-05-20T00:00:00.000Z"),
			mkRow("b2", "2026-05-26T00:00:00.000Z"),
			mkRow("b3", "2026-06-01T00:00:00.000Z"),
		];
		const since = Date.parse("2026-05-12T00:00:00.000Z");
		const until = Date.parse("2026-06-02T00:00:00.000Z");

		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			const overCapClient = new FakePerfSqlClient();
			overCapClient.rows = rows;
			const overCap = await new PostgresPerformanceMetricsStore(overCapClient, 2)
				.listWorkspaceWindowEvents({ workspaceId: "ws-1", since, until });
			expect(overCap.all).toHaveLength(2);
			expect(overCap.all.map((e) => e.id)).toEqual(["b2", "b3"]);
			expect(overCap.truncated).toBe(true);

			const exactFitClient = new FakePerfSqlClient();
			exactFitClient.rows = rows;
			const exactFit = await new PostgresPerformanceMetricsStore(exactFitClient, 3)
				.listWorkspaceWindowEvents({ workspaceId: "ws-1", since, until });
			expect(exactFit.all).toHaveLength(3);
			expect(exactFit.truncated).toBe(false);

			const underCapClient = new FakePerfSqlClient();
			underCapClient.rows = rows;
			const underCap = await new PostgresPerformanceMetricsStore(underCapClient, 4)
				.listWorkspaceWindowEvents({ workspaceId: "ws-1", since, until });
			expect(underCap.all).toHaveLength(3);
			expect(underCap.truncated).toBe(false);
		} finally {
			console.warn = originalWarn;
		}
	});

	test("getWorkspaceAggregate threads windowTruncated + windowEventLimit from the capped read", async () => {
		// Enough recent activity for one member; a tight cap forces truncation. The
		// aggregate must surface windowTruncated=true (so the dashboard can flag a
		// recent-only window) alongside the active windowEventLimit for the "latest N"
		// notice — and report a complete window when nothing is dropped.
		const mkRow = (id: string, createdAt: string) => ({
			id, workspace_id: "ws-1", user_id: "u1", project_id: null, role: "translator",
			event_type: "page_submitted", complexity_weight: 1, duration_ms: 600_000, metadata: "{}", created_at: createdAt,
		});
		// Recent rows inside the 4-week aggregate window ending at NOW.
		const rows = [
			mkRow("c1", new Date(NOW - 6 * 24 * 60 * 60 * 1000).toISOString()),
			mkRow("c2", new Date(NOW - 4 * 24 * 60 * 60 * 1000).toISOString()),
			mkRow("c3", new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString()),
			mkRow("c4", new Date(NOW - 1 * 24 * 60 * 60 * 1000).toISOString()),
		];

		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			const cappedClient = new FakePerfSqlClient();
			cappedClient.rows = rows;
			const cappedStore = new PostgresPerformanceMetricsStore(cappedClient, 2);
			const cappedAgg = await getWorkspaceAggregate({ workspaceId: "ws-1", now: NOW }, cappedStore);
			expect(cappedAgg.windowTruncated).toBe(true);
			// windowEventLimit reflects the active store cap so the client shows the
			// exact "latest N" figure used by the capped aggregation.
			expect(typeof cappedAgg.windowEventLimit).toBe("number");
			expect(cappedAgg.windowEventLimit).toBe(2);

			const roomyClient = new FakePerfSqlClient();
			roomyClient.rows = rows;
			const roomyStore = new PostgresPerformanceMetricsStore(roomyClient, 1000);
			const roomyAgg = await getWorkspaceAggregate({ workspaceId: "ws-1", now: NOW }, roomyStore);
			expect(roomyAgg.windowTruncated).toBe(false);
		} finally {
			console.warn = originalWarn;
		}
	});
});

// Build a WorkEvent the same way mapWorkEventRow does, for the cap-parity oracle.
function toWorkEvent(row: Record<string, unknown>): WorkEvent {
	return {
		id: String(row.id),
		workspaceId: String(row.workspace_id),
		userId: String(row.user_id),
		projectId: row.project_id == null ? undefined : String(row.project_id),
		role: String(row.role) as PerfRole,
		eventType: String(row.event_type) as PerfWorkEventType,
		complexityWeight: Number(row.complexity_weight),
		durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
		metadata: undefined,
		createdAt: String(row.created_at),
	};
}

// ── Route authz / visibility gates ─────────────────────────────────────────────────

import { performance as perfRouter, setPerfRoutesStoresForTests } from "../routes/performance.js";
import { generateTokens, createUser } from "../services/auth.service.js";

class FakeWorkspaceAccessStore implements Partial<WorkspaceAccessStore> {
	constructor(private readonly roleByUser: Record<string, WorkspaceRole>) {}

	private record(workspaceId: string, userId: string, role: WorkspaceRole): WorkspaceMemberRecord {
		return { workspaceId, userId, role, scope: {}, createdAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-01T00:00:00.000Z" };
	}

	async getMember(workspaceId: string, userId: string): Promise<WorkspaceMemberRecord | null> {
		const role = this.roleByUser[userId];
		return role ? this.record(workspaceId, userId, role) : null;
	}

	async requirePermission(workspaceId: string, userId: string, permission: WorkspacePermission): Promise<WorkspaceMemberRecord> {
		const role = this.roleByUser[userId];
		if (!role) {
			throw new WorkspaceAccessError("Not a member", 403, "workspace_access_denied");
		}
		if (!roleHasPermission(role, permission)) {
			throw new WorkspaceAccessError(`Forbidden: missing permission '${permission}'`, 403, "workspace_permission_denied");
		}
		return this.record(workspaceId, userId, role);
	}
}

describe("performance routes: authz + visibility", () => {
	let app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
	let leadToken = "";
	let memberToken = "";
	let viewerToken = "";
	let leadId = "";
	let memberId = "";
	let viewerId = "";
	let restore: () => void = () => {};
	const metricsStore = createStore();

	beforeAll(async () => {
		const { Hono } = await import("hono");
		const a = new (Hono as unknown as { new (): typeof app })();
		(a as unknown as { route: (p: string, r: unknown) => void }).route("/api/perf", perfRouter);
		app = a as unknown as typeof app;

		const lead = await createUser({ email: `lead-${uuid()}@example.com`, password: "Sup3r$ecret1", name: "Lead" });
		const member = await createUser({ email: `member-${uuid()}@example.com`, password: "Sup3r$ecret1", name: "Member" });
		const viewer = await createUser({ email: `viewer-${uuid()}@example.com`, password: "Sup3r$ecret1", name: "Viewer" });
		leadId = lead.user.id;
		memberId = member.user.id;
		viewerId = viewer.user.id;
		leadToken = (await generateTokens(lead.user)).accessToken;
		memberToken = (await generateTokens(member.user)).accessToken;
		viewerToken = (await generateTokens(viewer.user)).accessToken;

		restore = setPerfRoutesStoresForTests({
			workspaceAccessStore: new FakeWorkspaceAccessStore({ [leadId]: "owner", [memberId]: "editor", [viewerId]: "viewer" }) as unknown as WorkspaceAccessStore,
			metricsStore,
		});
	});

	afterEach(() => {
		// keep stores until all route tests complete; restored in final test
	});

	function auth(token: string): RequestInit {
		return { headers: { Authorization: `Bearer ${token}` } };
	}

	test("unauthenticated request is rejected", async () => {
		const res = await app.request("/api/perf/me?workspaceId=ws-1");
		expect(res.status).toBe(401);
	});

	test("a member can read their own scores", async () => {
		const res = await app.request("/api/perf/me?workspaceId=ws-1", auth(memberToken));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			scores: { userId: string };
			baseline: unknown;
			roi: unknown;
			windowTruncated: boolean;
			previousWindowTruncated: boolean;
			workspaceBaselineTruncated: boolean;
			windowEventLimit: number;
		};
		expect(body.scores.userId).toBe(memberId);
		expect(body.baseline).toBeDefined();
		expect(body.roi).toBeDefined();
		expect(body.windowTruncated).toBe(false);
		expect(body.previousWindowTruncated).toBe(false);
		expect(body.workspaceBaselineTruncated).toBe(false);
		expect(typeof body.windowEventLimit).toBe("number");
	});

	test("a non-lead member is FORBIDDEN from viewing another member's scores", async () => {
		const res = await app.request(`/api/perf/member/${leadId}?workspaceId=ws-1`, auth(memberToken));
		expect(res.status).toBe(403);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe("forbidden");
	});

	test("a lead/admin CAN view another member's scores", async () => {
		const res = await app.request(`/api/perf/member/${memberId}?workspaceId=ws-1`, auth(leadToken));
		expect(res.status).toBe(200);
	});

	test("any member can read the anonymized workspace aggregate", async () => {
		const res = await app.request("/api/perf/workspace?workspaceId=ws-1", auth(memberToken));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			aggregate: { memberCount: number; windowTruncated: boolean; windowEventLimit: number };
		};
		expect(body.aggregate).toBeDefined();
		// The truncation contract reaches the HTTP payload (additive fields). The
		// default cap is roomy enough for this small fixture, so the window is complete.
		expect(body.aggregate.windowTruncated).toBe(false);
		expect(typeof body.aggregate.windowEventLimit).toBe("number");
	});

	test("workspace-scope ROI requires lead/admin; self ROI is allowed", async () => {
		const forbidden = await app.request("/api/perf/roi?workspaceId=ws-1&scope=workspace", auth(memberToken));
		expect(forbidden.status).toBe(403);
		const selfOk = await app.request("/api/perf/roi?workspaceId=ws-1", auth(memberToken));
		expect(selfOk.status).toBe(200);
		const selfBody = (await selfOk.json()) as { scope: string; roi: unknown; windowTruncated: boolean; windowEventLimit: number };
		expect(selfBody.scope).toBe("self");
		expect(selfBody.roi).toBeDefined();
		expect(selfBody.windowTruncated).toBe(false);
		expect(typeof selfBody.windowEventLimit).toBe("number");
		const leadOk = await app.request("/api/perf/roi?workspaceId=ws-1&scope=workspace", auth(leadToken));
		expect(leadOk.status).toBe(200);
		const leadBody = (await leadOk.json()) as { scope: string; roi: unknown; windowTruncated: boolean; windowEventLimit: number };
		expect(leadBody.scope).toBe("workspace");
		expect(leadBody.roi).toBeDefined();
		expect(leadBody.windowTruncated).toBe(false);
	});

	test("recording an event for another member requires lead/admin", async () => {
		const forbidden = await app.request("/api/perf/event", {
			method: "POST",
			headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ workspaceId: "ws-1", userId: leadId, role: "translator", eventType: "page_submitted" }),
		});
		expect(forbidden.status).toBe(403);

		const ownOk = await app.request("/api/perf/event", {
			method: "POST",
			headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ workspaceId: "ws-1", role: "translator", eventType: "page_submitted" }),
		});
		expect(ownOk.status).toBe(200);
	});

	test("a read-only viewer CANNOT self-report events (provenance guard)", async () => {
		// viewer holds only read_workspace; the write path requires update_project so
		// a low-privilege member cannot inflate their own scores/ROI.
		const res = await app.request("/api/perf/event", {
			method: "POST",
			headers: { Authorization: `Bearer ${viewerToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ workspaceId: "ws-1", role: "translator", eventType: "page_submitted" }),
		});
		expect(res.status).toBe(403);
	});

	test("a lead recording for a NON-member subject is rejected (no phantom members)", async () => {
		const res = await app.request("/api/perf/event", {
			method: "POST",
			headers: { Authorization: `Bearer ${leadToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ workspaceId: "ws-1", userId: "ghost-user", role: "translator", eventType: "page_submitted" }),
		});
		expect(res.status).toBe(422);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe("subject_not_member");
	});

	test("a lead CAN record for a real workspace member", async () => {
		const res = await app.request("/api/perf/event", {
			method: "POST",
			headers: { Authorization: `Bearer ${leadToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ workspaceId: "ws-1", userId: memberId, role: "translator", eventType: "page_submitted" }),
		});
		expect(res.status).toBe(200);
	});

	test("event ingestion is idempotent on a repeated eventId", async () => {
		const eventId = `idem-${uuid()}`;
		const payload = JSON.stringify({ workspaceId: "ws-1", eventId, role: "translator", eventType: "page_submitted" });
		const headers = { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" };
		const first = await app.request("/api/perf/event", { method: "POST", headers, body: payload });
		const second = await app.request("/api/perf/event", { method: "POST", headers, body: payload });
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		const a = (await first.json()) as { eventId: string };
		const b = (await second.json()) as { eventId: string };
		expect(a.eventId).toBe(eventId);
		expect(b.eventId).toBe(eventId);
		// Only one event was actually stored despite two POSTs.
		const stored = await metricsStore.listEvents({ workspaceId: "ws-1" });
		expect(stored.filter((e) => e.id === eventId)).toHaveLength(1);
	});

	test("metadata is allowlisted; arbitrary surveilled fields are rejected", async () => {
		// Allowed derived field passes.
		const ok = await app.request("/api/perf/event", {
			method: "POST",
			headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ workspaceId: "ws-1", role: "translator", eventType: "lock_handoff", metadata: { handoffLatencyMs: 1000 } }),
		});
		expect(ok.status).toBe(200);
		// Arbitrary raw-telemetry field is rejected by the strict allowlist.
		const bad = await app.request("/api/perf/event", {
			method: "POST",
			headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ workspaceId: "ws-1", role: "translator", eventType: "page_submitted", metadata: { keystrokes: [1, 2, 3] } }),
		});
		expect(bad.status).toBe(400);
	});

	test("unknown event type / role are rejected (no raw activity tracking)", async () => {
		const res = await app.request("/api/perf/event", {
			method: "POST",
			headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ workspaceId: "ws-1", role: "translator", eventType: "mouse_move" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe("invalid_event_type");
		restore();
	});
});

// ── Cross-workspace project-binding guard (perf/event) ─────────────────────────────
// A perf event whose projectId belongs to a DIFFERENT workspace than data.workspaceId
// must be rejected so a member with update_project in workspace A cannot bind a project
// owned by workspace B into A's analytics. Same-workspace projects still succeed.

import type { ProjectAccessCheck, ProjectCatalogStore, ProjectWorkspacePlan } from "../services/project-catalog.js";

// Minimal fake: a fixed map of projectId → owning workspaceId. getProjectWorkspacePlan
// returns null for an unknown (or personal/non-workspace) project, mirroring the real
// store. canAccessProject is permissive here so the test isolates the WORKSPACE-BINDING
// gate (the per-member scope gate is already covered elsewhere).
class FakeProjectCatalogStore implements Partial<ProjectCatalogStore> {
	constructor(private readonly workspaceByProject: Record<string, string>) {}

	async getProjectWorkspacePlan(projectId: string): Promise<ProjectWorkspacePlan | null> {
		const workspaceId = this.workspaceByProject[projectId.trim()];
		if (!workspaceId) return null;
		return { projectId: projectId.trim(), workspaceId, planId: "plan-test" };
	}

	async canAccessProject(_input: ProjectAccessCheck): Promise<boolean> {
		return true;
	}
}

describe("performance routes: cross-workspace project binding", () => {
	let app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
	let memberToken = "";
	let memberId = "";
	let restore: () => void = () => {};
	const metricsStore = createStore();

	beforeAll(async () => {
		const { Hono } = await import("hono");
		const a = new (Hono as unknown as { new (): typeof app })();
		(a as unknown as { route: (p: string, r: unknown) => void }).route("/api/perf", perfRouter);
		app = a as unknown as typeof app;

		const member = await createUser({ email: `bind-${uuid()}@example.com`, password: "Sup3r$ecret1", name: "Binder" });
		memberId = member.user.id;
		memberToken = (await generateTokens(member.user)).accessToken;

		restore = setPerfRoutesStoresForTests({
			workspaceAccessStore: new FakeWorkspaceAccessStore({ [memberId]: "editor" }) as unknown as WorkspaceAccessStore,
			metricsStore,
			// project-A belongs to ws-A; project-B belongs to a DIFFERENT workspace ws-B.
			projectCatalogStore: new FakeProjectCatalogStore({ "project-A": "ws-A", "project-B": "ws-B" }) as unknown as ProjectCatalogStore,
		});
	});

	function post(body: unknown): Response | Promise<Response> {
		return app.request("/api/perf/event", {
			method: "POST",
			headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	test("a same-workspace project is accepted", async () => {
		const res = await post({ workspaceId: "ws-A", projectId: "project-A", role: "translator", eventType: "page_submitted" });
		expect(res.status).toBe(200);
	});

	test("a project owned by a DIFFERENT workspace is rejected (binding bypass)", async () => {
		const res = await post({ workspaceId: "ws-A", projectId: "project-B", role: "translator", eventType: "page_submitted" });
		expect(res.status).toBe(403);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe("perf_project_workspace_mismatch");
	});

	test("an unknown / personal (non-workspace) project is rejected", async () => {
		const res = await post({ workspaceId: "ws-A", projectId: "project-unknown", role: "translator", eventType: "page_submitted" });
		expect(res.status).toBe(403);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe("perf_project_workspace_mismatch");

		// Only the legit same-workspace event was recorded; neither cross-workspace
		// attempt polluted ws-A's analytics.
		const stored = await metricsStore.listEvents({ workspaceId: "ws-A" });
		expect(stored.every((e) => e.projectId === "project-A")).toBe(true);
		restore();
	});
});

// ── helpers ──────────────────────────────────────────────────────────────────────

import { aggregateEvents } from "../services/performance-intelligence.js";

function aggregate(inputs: WorkEventInput[]) {
	return aggregateEvents(inputs.map(normalize));
}

function normalize(input: WorkEventInput) {
	return {
		id: input.id ?? uuid(),
		workspaceId: input.workspaceId,
		userId: input.userId,
		projectId: input.projectId,
		role: input.role,
		eventType: input.eventType,
		complexityWeight: Number.isFinite(input.complexityWeight) && input.complexityWeight >= 0 ? input.complexityWeight : 1,
		durationMs: input.durationMs,
		metadata: input.metadata,
		createdAt: input.createdAt ?? new Date().toISOString(),
	};
}

function times<T>(n: number, fn: () => T): T[] {
	return Array.from({ length: n }, () => fn());
}
