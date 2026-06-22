import { getSharedBunSql } from "./sql-pool.js";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { v4 as uuid } from "uuid";
import { DATA_DIR, serverConfig } from "../config.js";
import { readJsonFile } from "../utils/json-file.js";

// ── W2.15 Performance Intelligence ────────────────────────────────────────────
//
// Computes a 5-dimension performance profile (0-100) per workspace member from
// DERIVED domain events only — never raw clicks/keystrokes/surveilled timers.
//
// Dimensions (weights for the composite in parentheses):
//   throughput   (25) — pages/hr, complexity-adjusted
//   quality      (35) — inverse of revision/QC-reject rate
//   consistency  (15) — TM-hit + glossary-adherence
//   ai_leverage  (10) — accept-rate − post-accept-edit-rate
//   collaboration(15) — comment-resolve ratio + handoff smoothness
//
// Scores are EWMA-smoothed (α=0.3) across weekly periods and Bayesian-shrunk
// toward a role baseline when the sample size is small. Three comparison
// baselines: vs self (trailing 4 weeks), vs workspace median, and vs an
// anonymized platform percentile band (p50/p75/p90), the last opt-in only.

export const PERF_DIMENSIONS = [
	"throughput",
	"quality",
	"consistency",
	"ai_leverage",
	"collaboration",
] as const;

export type PerfDimension = (typeof PERF_DIMENSIONS)[number];

/** Composite weights. Sum = 100. */
export const DIMENSION_WEIGHTS: Record<PerfDimension, number> = {
	throughput: 25,
	quality: 35,
	consistency: 15,
	ai_leverage: 10,
	collaboration: 15,
};

/** EWMA smoothing factor. Higher = more weight on the latest period. */
export const EWMA_ALPHA = 0.3;

/**
 * Bayesian shrinkage strength: the number of "prior" pseudo-observations the
 * role baseline is worth. With sample_size n and baseline μ, the shrunk score
 * is (n·raw + K·μ) / (n + K). Low n → score pulled toward the role baseline.
 */
export const SHRINKAGE_PRIOR_WEIGHT = 8;

export const PERF_WORK_EVENT_TYPES = [
	"page_submitted",
	"qc_rejected",
	"revision_requested",
	"comment_resolved",
	"comment_opened",
	"ai_suggestion_accepted",
	"ai_suggestion_edited",
	"ai_suggestion_rejected",
	"tm_hit",
	"glossary_hit",
	"glossary_miss",
	"lock_handoff",
] as const;

export type PerfWorkEventType = (typeof PERF_WORK_EVENT_TYPES)[number];

export type PerfRole = "translator" | "cleaner" | "typesetter" | "qc" | "reviewer";

const PERF_ROLES: PerfRole[] = ["translator", "cleaner", "typesetter", "qc", "reviewer"];

export interface WorkEvent {
	id: string;
	workspaceId: string;
	userId: string;
	projectId?: string;
	role: PerfRole;
	eventType: PerfWorkEventType;
	/** Relative complexity of the work unit. >= 0; defaults to 1. */
	complexityWeight: number;
	/** Optional, already-derived task duration in ms. Never a surveilled timer. */
	durationMs?: number;
	metadata?: Record<string, unknown>;
	createdAt: string;
}

export type WorkEventInput = Omit<WorkEvent, "id" | "createdAt"> & {
	id?: string;
	createdAt?: string;
};

export type WorkEventSortOrder = "asc" | "desc";

export interface WorkEventKeysetCursor {
	createdAt: string;
	id: string;
}

export interface PerfScoreRecord {
	workspaceId: string;
	/** null = workspace-aggregate row. */
	userId: string | null;
	dimension: PerfDimension | "composite";
	score: number;
	periodStart: string;
	sampleSize: number;
	computedAt: string;
}

export interface WorkEventQuery {
	workspaceId: string;
	userId?: string;
	since?: number;
	until?: number;
	/**
	 * Bounded reads are the safe default for dashboard/ROI aggregation. The
	 * optional keyset fields let future callers page older/newer slices without
	 * OFFSET, which would get slower as work_events grows.
	 */
	limit?: number;
	order?: WorkEventSortOrder;
	before?: WorkEventKeysetCursor;
	after?: WorkEventKeysetCursor;
}

export interface PerformanceMetricsStore {
	recordEvent(input: WorkEventInput): Promise<WorkEvent>;
	listEvents(query: WorkEventQuery): Promise<WorkEvent[]>;
	listWorkspaceUserIds(workspaceId: string): Promise<string[]>;
	getWindowEventLimit?(): number;
	/**
	 * rank8: load EVERY member's events for a workspace window in ONE query and
	 * return them grouped by user. Replaces the per-member listEvents N+1 (and the
	 * duplicate full-window refetch) used by the perf dashboard. Optional so test
	 * doubles / legacy stores can omit it; the service falls back to one bounded
	 * workspace listEvents read when it's absent.
	 */
	listWorkspaceWindowEvents?(query: { workspaceId: string; since?: number; until?: number }): Promise<WorkspaceWindowEvents>;
}

/**
 * Group an ordered, single-workspace event list by userId, preserving order.
 * `truncated` marks that the source read hit the window-event cap and dropped
 * the OLDEST events — the grouped result is then a recent-only slice, not the
 * full window.
 */
function groupWorkspaceWindowEvents(events: WorkEvent[], truncated = false): WorkspaceWindowEvents {
	const byUser = new Map<string, WorkEvent[]>();
	for (const event of events) {
		const list = byUser.get(event.userId);
		if (list) list.push(event);
		else byUser.set(event.userId, [event]);
	}
	return { all: events, byUser, truncated };
}

/**
 * Result of the single grouped workspace-window read (rank8): every member's
 * windowed events fetched in ONE query, already partitioned by user, plus the
 * flat all-events list so callers can compute workspace ROI without a second
 * full-window refetch. Optional store capability — the service falls back to the
 * legacy per-member loop for stores that don't implement it.
 */
export interface WorkspaceWindowEvents {
	/** Every in-window event for the workspace, ordered (created_at, id) ascending. */
	all: WorkEvent[];
	/** The same events grouped by userId, each group keeping the global ordering. */
	byUser: Map<string, WorkEvent[]>;
	/**
	 * True when the read hit PERF_WINDOW_EVENT_LIMIT and the OLDEST in-window
	 * events were dropped. The grouped result is then a recent-only slice — some
	 * older events, and any member whose activity falls entirely in the dropped
	 * slice, are missing from the aggregates/medians/ROI computed downstream.
	 * Callers surface this so the dashboard never presents a truncated scan as a
	 * complete-period figure.
	 */
	truncated: boolean;
}

interface CappedWorkEventWindow {
	events: WorkEvent[];
	truncated: boolean;
	limit: number;
}

function normalizeWindowEventLimit(value: number): number {
	if (!Number.isFinite(value)) return 50_000;
	return Math.max(1, Math.floor(value));
}

function getStoreWindowEventLimit(store: PerformanceMetricsStore): number {
	return normalizeWindowEventLimit(store.getWindowEventLimit?.() ?? serverConfig.performanceWindowEventLimit);
}

function normalizeWorkEventReadLimit(limit: number | undefined, windowEventLimit: number): number {
	const normalizedWindowLimit = normalizeWindowEventLimit(windowEventLimit);
	if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return normalizedWindowLimit;
	// Allow one extra sentinel row for truncation detection, but never an
	// arbitrarily large caller-supplied scan.
	return Math.min(Math.floor(limit), normalizedWindowLimit + 1);
}

function normalizeWorkEventCursor(cursor: WorkEventKeysetCursor | undefined): WorkEventKeysetCursor | undefined {
	if (!cursor || typeof cursor.id !== "string" || cursor.id.length === 0) return undefined;
	if (!Number.isFinite(Date.parse(cursor.createdAt))) return undefined;
	return cursor;
}

function compareWorkEventKey(left: Pick<WorkEvent, "createdAt" | "id">, right: Pick<WorkEvent, "createdAt" | "id">): number {
	const parsedLeftTime = Date.parse(left.createdAt);
	const parsedRightTime = Date.parse(right.createdAt);
	const leftTime = Number.isFinite(parsedLeftTime) ? parsedLeftTime : 0;
	const rightTime = Number.isFinite(parsedRightTime) ? parsedRightTime : 0;
	if (leftTime !== rightTime) return leftTime - rightTime;
	return left.id.localeCompare(right.id);
}

function orderWorkEvents(events: WorkEvent[], order: WorkEventSortOrder): WorkEvent[] {
	const direction = order === "desc" ? -1 : 1;
	return [...events].sort((a, b) => compareWorkEventKey(a, b) * direction);
}

function capNewestEvents(events: WorkEvent[], limit: number): CappedWorkEventWindow {
	const normalizedLimit = normalizeWindowEventLimit(limit);
	const newest = orderWorkEvents(events, "desc");
	const truncated = newest.length > normalizedLimit;
	const kept = newest.slice(0, normalizedLimit);
	return { events: orderWorkEvents(kept, "asc"), truncated, limit: normalizedLimit };
}

function sortWorkspaceWindowEvents(events: WorkEvent[]): WorkEvent[] {
	return [...events].sort((a, b) => {
		const user = a.userId.localeCompare(b.userId);
		if (user !== 0) return user;
		return compareWorkEventKey(a, b);
	});
}

function warnWindowTruncated(scope: string, query: { workspaceId: string; userId?: string; since?: number; until?: number }, limit: number): void {
	console.warn(
		`[PerformanceIntelligence] ${scope} truncated to PERF_WINDOW_EVENT_LIMIT=${limit} ` +
		`for workspace ${query.workspaceId}${query.userId ? ` user ${query.userId}` : ""} ` +
		`(window ${query.since ?? "-inf"}..${query.until ?? "+inf"}); ` +
		`oldest events in the window were dropped — raise PERF_WINDOW_EVENT_LIMIT if scores look off.`,
	);
}

async function listCappedWindowEvents(
	store: PerformanceMetricsStore,
	query: { workspaceId: string; userId?: string; since?: number; until?: number },
	scope: string,
): Promise<CappedWorkEventWindow> {
	const limit = getStoreWindowEventLimit(store);
	const rows = await store.listEvents({ ...query, order: "desc", limit: limit + 1 });
	// The store should honor DESC + LIMIT in SQL, but we cap again here so legacy
	// test doubles or file-backed stores cannot accidentally feed an unbounded
	// payload into aggregation.
	const capped = capNewestEvents(rows, limit);
	if (capped.truncated) warnWindowTruncated(scope, query, capped.limit);
	return capped;
}

async function listWorkspaceWindowEventsCapped(
	store: PerformanceMetricsStore,
	query: { workspaceId: string; since?: number; until?: number },
): Promise<WorkspaceWindowEvents> {
	if (store.listWorkspaceWindowEvents) {
		return store.listWorkspaceWindowEvents(query);
	}
	const capped = await listCappedWindowEvents(store, query, "workspace fallback window");
	return groupWorkspaceWindowEvents(sortWorkspaceWindowEvents(capped.events), capped.truncated);
}

// ── Role baselines (smart defaults) ───────────────────────────────────────────
//
// "normal" pages/hr per role; these anchor the throughput normalization and the
// Bayesian shrinkage prior (expressed as a 0-100 baseline score where the
// "normal" rate maps to 60 — solid-but-not-exceptional).

export interface RoleBaseline {
	/** "Normal" complexity-adjusted pages/hr that maps to a throughput score of 60. */
	normalPagesPerHour: number;
	/** Default 0-100 baseline score per dimension used as the shrinkage prior. */
	dimensionBaseline: Record<PerfDimension, number>;
	/** Average minutes a human would spend retyping one TM-eligible segment. */
	avgRetypeMinutesPerHit: number;
}

const NEUTRAL_DIMENSION_BASELINE: Record<PerfDimension, number> = {
	throughput: 60,
	quality: 70,
	consistency: 65,
	ai_leverage: 50,
	collaboration: 65,
};

export const ROLE_BASELINES: Record<PerfRole, RoleBaseline> = {
	translator: {
		normalPagesPerHour: 3,
		dimensionBaseline: { ...NEUTRAL_DIMENSION_BASELINE },
		avgRetypeMinutesPerHit: 1.5,
	},
	cleaner: {
		normalPagesPerHour: 6,
		dimensionBaseline: { ...NEUTRAL_DIMENSION_BASELINE, ai_leverage: 40, consistency: 60 },
		avgRetypeMinutesPerHit: 0.5,
	},
	typesetter: {
		normalPagesPerHour: 4,
		dimensionBaseline: { ...NEUTRAL_DIMENSION_BASELINE, ai_leverage: 40 },
		avgRetypeMinutesPerHit: 0.75,
	},
	qc: {
		normalPagesPerHour: 10,
		dimensionBaseline: { ...NEUTRAL_DIMENSION_BASELINE, quality: 75, collaboration: 70 },
		avgRetypeMinutesPerHit: 0.5,
	},
	reviewer: {
		normalPagesPerHour: 8,
		dimensionBaseline: { ...NEUTRAL_DIMENSION_BASELINE, collaboration: 72 },
		avgRetypeMinutesPerHit: 0.5,
	},
};

export function roleBaseline(role: PerfRole): RoleBaseline {
	return ROLE_BASELINES[role] ?? ROLE_BASELINES.translator;
}

export const HOURLY_RATE_USD = 20;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_PERIOD_WEEKS = 4;

// ── Pure scoring math ─────────────────────────────────────────────────────────

export function clampScore(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 100) return 100;
	return Math.round(value * 100) / 100;
}

/** Safe ratio that never divides by zero. */
export function safeRatio(numerator: number, denominator: number, fallback = 0): number {
	if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return fallback;
	return numerator / denominator;
}

/**
 * Exponentially-weighted moving average over an ordered series (oldest first).
 * Returns the series with no smoothing applied to the first value, then
 * s_t = α·x_t + (1-α)·s_{t-1}. Empty series → 0.
 */
export function ewma(series: number[], alpha = EWMA_ALPHA): number {
	if (series.length === 0) return 0;
	const a = clamp01(alpha);
	let smoothed = series[0] ?? 0;
	for (let i = 1; i < series.length; i++) {
		smoothed = a * (series[i] ?? 0) + (1 - a) * smoothed;
	}
	return smoothed;
}

/**
 * Bayesian shrinkage toward a prior baseline. With n observations behind a raw
 * score and a prior worth K pseudo-observations, the posterior mean is
 * (n·raw + K·prior) / (n + K). Low n → shrunk toward `prior`.
 */
export function bayesianShrink(raw: number, sampleSize: number, prior: number, priorWeight = SHRINKAGE_PRIOR_WEIGHT): number {
	const n = Math.max(0, sampleSize);
	const k = Math.max(0, priorWeight);
	if (n + k <= 0) return prior;
	return (n * raw + k * prior) / (n + k);
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/** Median of a numeric list. Empty → 0. */
export function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

/**
 * Percentile rank (0-100) of `value` within `population` using the
 * "fraction strictly below + half of equal" convention. Empty population → 50
 * (no signal ⇒ assume median). This is what positions a member within the
 * anonymized platform distribution.
 */
export function percentileRank(value: number, population: number[]): number {
	if (population.length === 0) return 50;
	let below = 0;
	let equal = 0;
	for (const v of population) {
		if (v < value) below += 1;
		else if (v === value) equal += 1;
	}
	return clampScore(((below + equal / 2) / population.length) * 100);
}

/** p50/p75/p90 bands of a population. Empty → all zero. */
export function percentileBands(population: number[]): { p50: number; p75: number; p90: number } {
	return {
		p50: percentileValue(population, 0.5),
		p75: percentileValue(population, 0.75),
		p90: percentileValue(population, 0.9),
	};
}

export function percentileValue(population: number[], q: number): number {
	if (population.length === 0) return 0;
	const sorted = [...population].sort((a, b) => a - b);
	if (sorted.length === 1) return sorted[0] ?? 0;
	const rank = clamp01(q) * (sorted.length - 1);
	const low = Math.floor(rank);
	const high = Math.ceil(rank);
	const lowValue = sorted[low] ?? 0;
	const highValue = sorted[high] ?? 0;
	if (low === high) return lowValue;
	const weight = rank - low;
	return lowValue * (1 - weight) + highValue * weight;
}

// ── Event-window aggregation → per-dimension raw scores ───────────────────────

export interface EventCounts {
	pagesSubmitted: number;
	complexityPagesSubmitted: number;
	/**
	 * Complexity-weighted page count restricted to pages that carried a duration
	 * sample. This is the throughput numerator: pairing it with totalDurationMs
	 * keeps pages/hour honest when only some pages are timed (untimed pages must
	 * not inflate the rate against the timed-only denominator).
	 */
	complexityPagesTimed: number;
	qcRejected: number;
	revisionRequested: number;
	commentsResolved: number;
	commentsOpened: number;
	aiAccepted: number;
	aiEdited: number;
	aiRejected: number;
	tmHits: number;
	glossaryHits: number;
	glossaryMisses: number;
	lockHandoffs: number;
	totalDurationMs: number;
	durationSamples: number;
	handoffLatencySamples: number;
	totalHandoffLatencyMs: number;
}

function emptyCounts(): EventCounts {
	return {
		pagesSubmitted: 0,
		complexityPagesSubmitted: 0,
		complexityPagesTimed: 0,
		qcRejected: 0,
		revisionRequested: 0,
		commentsResolved: 0,
		commentsOpened: 0,
		aiAccepted: 0,
		aiEdited: 0,
		aiRejected: 0,
		tmHits: 0,
		glossaryHits: 0,
		glossaryMisses: 0,
		lockHandoffs: 0,
		totalDurationMs: 0,
		durationSamples: 0,
		handoffLatencySamples: 0,
		totalHandoffLatencyMs: 0,
	};
}

export function aggregateEvents(events: WorkEvent[]): EventCounts {
	const counts = emptyCounts();
	for (const event of events) {
		const weight = Number.isFinite(event.complexityWeight) && event.complexityWeight > 0 ? event.complexityWeight : 1;
		switch (event.eventType) {
			case "page_submitted":
				counts.pagesSubmitted += 1;
				counts.complexityPagesSubmitted += weight;
				if (typeof event.durationMs === "number" && event.durationMs > 0) {
					counts.totalDurationMs += event.durationMs;
					counts.durationSamples += 1;
					// Only timed pages contribute to the throughput numerator so they
					// stay consistent with the timed-only totalDurationMs denominator.
					counts.complexityPagesTimed += weight;
				}
				break;
			case "qc_rejected":
				counts.qcRejected += 1;
				break;
			case "revision_requested":
				counts.revisionRequested += 1;
				break;
			case "comment_resolved":
				counts.commentsResolved += 1;
				break;
			case "comment_opened":
				counts.commentsOpened += 1;
				break;
			case "ai_suggestion_accepted":
				counts.aiAccepted += 1;
				break;
			case "ai_suggestion_edited":
				counts.aiEdited += 1;
				break;
			case "ai_suggestion_rejected":
				counts.aiRejected += 1;
				break;
			case "tm_hit":
				counts.tmHits += 1;
				break;
			case "glossary_hit":
				counts.glossaryHits += 1;
				break;
			case "glossary_miss":
				counts.glossaryMisses += 1;
				break;
			case "lock_handoff": {
				counts.lockHandoffs += 1;
				const latency = readNumber(event.metadata?.handoffLatencyMs);
				if (latency !== undefined && latency >= 0) {
					counts.totalHandoffLatencyMs += latency;
					counts.handoffLatencySamples += 1;
				}
				break;
			}
		}
	}
	return counts;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Total sample size driving a member's score in a window. Used for Bayesian
 * shrinkage and reported alongside scores so callers can gauge confidence.
 */
export function windowSampleSize(counts: EventCounts): number {
	return (
		counts.pagesSubmitted +
		counts.qcRejected +
		counts.revisionRequested +
		counts.commentsResolved +
		counts.commentsOpened +
		counts.aiAccepted +
		counts.aiEdited +
		counts.aiRejected +
		counts.tmHits +
		counts.glossaryHits +
		counts.glossaryMisses +
		counts.lockHandoffs
	);
}

/**
 * Raw (pre-shrinkage) 0-100 score for a single dimension from one window's
 * counts. Each is defensively division-by-zero safe.
 */
export function rawDimensionScore(dimension: PerfDimension, counts: EventCounts, role: PerfRole): number {
	const baseline = roleBaseline(role);
	switch (dimension) {
		case "throughput": {
			// Complexity-adjusted pages per hour, normalized so the role's "normal"
			// rate maps to 60 and 2× normal maps to ~100.
			if (counts.durationSamples === 0 || counts.totalDurationMs <= 0) {
				// No timing signal: cannot measure throughput — neutral baseline anchor.
				return baseline.dimensionBaseline.throughput;
			}
			const hours = counts.totalDurationMs / 3_600_000;
			// Numerator is restricted to timed pages so untimed pages cannot inflate
			// the rate against the timed-only totalDurationMs denominator.
			const pagesPerHour = safeRatio(counts.complexityPagesTimed, hours);
			const ratio = safeRatio(pagesPerHour, baseline.normalPagesPerHour);
			return clampScore(ratio * 60);
		}
		case "quality": {
			// Inverse of the rework rate: rejections+revisions per submitted page.
			const submitted = counts.pagesSubmitted;
			if (submitted === 0) return baseline.dimensionBaseline.quality;
			const reworkRate = clamp01(safeRatio(counts.qcRejected + counts.revisionRequested, submitted));
			return clampScore((1 - reworkRate) * 100);
		}
		case "consistency": {
			// Leverage of TM + glossary adherence. tm/glossary hits relative to
			// pages worked, plus glossary adherence (hits / (hits+misses)).
			const pages = Math.max(counts.pagesSubmitted, 1);
			const reuseSignal = clamp01(safeRatio(counts.tmHits + counts.glossaryHits, pages * 2));
			const glossaryTotal = counts.glossaryHits + counts.glossaryMisses;
			const adherence = glossaryTotal === 0 ? null : clamp01(safeRatio(counts.glossaryHits, glossaryTotal));
			if (counts.tmHits + counts.glossaryHits + counts.glossaryMisses === 0) {
				return baseline.dimensionBaseline.consistency;
			}
			// Blend reuse and adherence; when no glossary signal, lean on reuse.
			const blended = adherence === null ? reuseSignal : 0.5 * reuseSignal + 0.5 * adherence;
			return clampScore(blended * 100);
		}
		case "ai_leverage": {
			// accept-rate − post-accept-edit-rate. High accept with low subsequent
			// editing = effective AI use.
			const totalSuggestions = counts.aiAccepted + counts.aiEdited + counts.aiRejected;
			if (totalSuggestions === 0) return baseline.dimensionBaseline.ai_leverage;
			const acceptRate = clamp01(safeRatio(counts.aiAccepted + counts.aiEdited, totalSuggestions));
			const acceptedTotal = counts.aiAccepted + counts.aiEdited;
			const editRate = acceptedTotal === 0 ? 0 : clamp01(safeRatio(counts.aiEdited, acceptedTotal));
			return clampScore((acceptRate - editRate) * 100);
		}
		case "collaboration": {
			// Resolve ratio (resolved / opened comment population) + handoff
			// smoothness (fast handoffs = high). Neutral with no collaboration signal.
			//
			// The denominator is the total opened comment population, NOT
			// opened+resolved: in the normal open-then-resolve lifecycle both events
			// fire for the same comment, so summing them would double-count and cap a
			// perfectly-resolved set at 50%. We take max(opened, resolved) so a fully
			// resolved set scores 100% and resolutions whose open event was not
			// recorded (relaxed prototype telemetry) still yield a sane denominator.
			const commentPopulation = Math.max(counts.commentsOpened, counts.commentsResolved);
			const hasResolveSignal = commentPopulation > 0;
			const hasHandoffSignal = counts.lockHandoffs > 0;
			if (!hasResolveSignal && !hasHandoffSignal) {
				return baseline.dimensionBaseline.collaboration;
			}
			const resolveRatio = hasResolveSignal ? clamp01(safeRatio(counts.commentsResolved, commentPopulation)) : null;
			// Handoff smoothness: <30min avg latency → 1.0, scaling down to 0 at 4h.
			let handoffSmoothness: number | null = null;
			if (hasHandoffSignal) {
				if (counts.handoffLatencySamples === 0) {
					handoffSmoothness = 0.7; // handoffs happened but no latency data: assume decent
				} else {
					const avgLatencyMs = safeRatio(counts.totalHandoffLatencyMs, counts.handoffLatencySamples);
					const avgMinutes = avgLatencyMs / 60_000;
					handoffSmoothness = clamp01(1 - (avgMinutes - 30) / (240 - 30));
				}
			}
			const parts = [resolveRatio, handoffSmoothness].filter((p): p is number => p !== null);
			const blended = parts.reduce((sum, p) => sum + p, 0) / parts.length;
			return clampScore(blended * 100);
		}
	}
}

// ── Period bucketing + smoothed score computation ─────────────────────────────

export function weekStart(timestamp: number): number {
	// UTC week buckets anchored at Unix epoch (a Thursday); deterministic and
	// timezone-stable. We only need a stable, monotone bucket key.
	return Math.floor(timestamp / WEEK_MS) * WEEK_MS;
}

export interface DimensionResult {
	dimension: PerfDimension;
	score: number;
	rawLatest: number;
	sampleSize: number;
}

export interface MemberScoreResult {
	workspaceId: string;
	userId: string;
	role: PerfRole;
	periodStart: string;
	sampleSize: number;
	dimensions: Record<PerfDimension, DimensionResult>;
	composite: number;
	computedAt: string;
}

/**
 * Compute a member's smoothed, shrunk per-dimension scores + composite from a
 * raw event list. Events are bucketed into weekly periods; per period a raw
 * score is computed, the series is EWMA-smoothed, then Bayesian-shrunk toward
 * the role baseline using the total sample size.
 */
export function computeMemberScores(
	events: WorkEvent[],
	options: { workspaceId: string; userId: string; role?: PerfRole; now?: number; periodWeeks?: number },
): MemberScoreResult {
	const now = options.now ?? Date.now();
	const periodWeeks = options.periodWeeks ?? DEFAULT_PERIOD_WEEKS;
	const windowStart = weekStart(now) - (periodWeeks - 1) * WEEK_MS;
	const scoped = events.filter((e) => {
		const t = Date.parse(e.createdAt);
		return Number.isFinite(t) && t >= windowStart;
	});
	const role = options.role ?? inferRole(scoped) ?? "translator";
	const baseline = roleBaseline(role);

	// Group events by week bucket, oldest first.
	const buckets = new Map<number, WorkEvent[]>();
	for (const event of scoped) {
		const bucket = weekStart(Date.parse(event.createdAt));
		const list = buckets.get(bucket) ?? [];
		list.push(event);
		buckets.set(bucket, list);
	}
	const orderedBuckets = [...buckets.entries()].sort((a, b) => a[0] - b[0]);

	const totalCounts = aggregateEvents(scoped);
	const totalSamples = windowSampleSize(totalCounts);

	const dimensions = {} as Record<PerfDimension, DimensionResult>;
	for (const dimension of PERF_DIMENSIONS) {
		const series = orderedBuckets.map(([, bucketEvents]) => rawDimensionScore(dimension, aggregateEvents(bucketEvents), role));
		const smoothed = series.length > 0 ? ewma(series, EWMA_ALPHA) : baseline.dimensionBaseline[dimension];
		const shrunk = bayesianShrink(smoothed, totalSamples, baseline.dimensionBaseline[dimension]);
		dimensions[dimension] = {
			dimension,
			score: clampScore(shrunk),
			rawLatest: clampScore(series.length > 0 ? (series[series.length - 1] ?? baseline.dimensionBaseline[dimension]) : baseline.dimensionBaseline[dimension]),
			sampleSize: totalSamples,
		};
	}

	const composite = compositeScore(dimensions);

	return {
		workspaceId: options.workspaceId,
		userId: options.userId,
		role,
		periodStart: new Date(windowStart).toISOString(),
		sampleSize: totalSamples,
		dimensions,
		composite,
		computedAt: new Date(now).toISOString(),
	};
}

export function compositeScore(dimensions: Record<PerfDimension, { score: number }>): number {
	let weighted = 0;
	let totalWeight = 0;
	for (const dimension of PERF_DIMENSIONS) {
		const weight = DIMENSION_WEIGHTS[dimension];
		weighted += dimensions[dimension].score * weight;
		totalWeight += weight;
	}
	return clampScore(safeRatio(weighted, totalWeight));
}

function inferRole(events: WorkEvent[]): PerfRole | undefined {
	const tally = new Map<PerfRole, number>();
	for (const event of events) {
		if (PERF_ROLES.includes(event.role)) {
			tally.set(event.role, (tally.get(event.role) ?? 0) + 1);
		}
	}
	let best: PerfRole | undefined;
	let bestCount = 0;
	for (const [role, count] of tally) {
		if (count > bestCount) {
			best = role;
			bestCount = count;
		}
	}
	return best;
}

// ── Baselines / comparisons ───────────────────────────────────────────────────

export interface BaselineComparison {
	composite: number;
	vsSelf: { previousComposite: number | null; delta: number | null };
	vsWorkspace: { median: number; delta: number };
	vsPlatform: { percentile: number; bands: { p50: number; p75: number; p90: number } } | null;
}

export function buildBaselineComparison(input: {
	composite: number;
	selfPreviousComposite: number | null;
	workspaceComposites: number[];
	platformComposites: number[] | null;
}): BaselineComparison {
	const workspaceMedian = median(input.workspaceComposites);
	return {
		composite: clampScore(input.composite),
		vsSelf: {
			previousComposite: input.selfPreviousComposite,
			delta: input.selfPreviousComposite === null ? null : clampScore(input.composite) - input.selfPreviousComposite,
		},
		vsWorkspace: {
			median: clampScore(workspaceMedian),
			delta: clampScore(input.composite) - clampScore(workspaceMedian),
		},
		vsPlatform: input.platformComposites === null
			? null
			: {
				percentile: percentileRank(input.composite, input.platformComposites),
				bands: percentileBands(input.platformComposites),
			},
	};
}

// ── ROI ────────────────────────────────────────────────────────────────────────

export interface RoiMetrics {
	tmHits: number;
	aiCaughtIssues: number;
	timeSavedMinutes: number;
	timeSavedHours: number;
	moneySavedUsd: number;
	hourlyRateUsd: number;
}

/**
 * ROI from derived signals only:
 *   time_saved = TM hits × avg-retype-minutes + AI-caught issues × retype proxy
 *   money_saved = time_saved (hours) × $20/hr
 * "AI-caught issues" = accepted+edited AI suggestions (each avoided manual work).
 */
export function computeRoi(events: WorkEvent[], options: { now?: number } = {}): RoiMetrics {
	let tmHits = 0;
	let aiCaughtIssues = 0;
	let timeSavedMinutes = 0;
	for (const event of events) {
		const baseline = roleBaseline(event.role);
		if (event.eventType === "tm_hit") {
			tmHits += 1;
			timeSavedMinutes += baseline.avgRetypeMinutesPerHit;
		} else if (event.eventType === "ai_suggestion_accepted" || event.eventType === "ai_suggestion_edited") {
			aiCaughtIssues += 1;
			// An accepted/edited AI suggestion saves a portion of a retype; edited
			// suggestions still required some manual touch so count edits at half.
			const factor = event.eventType === "ai_suggestion_accepted" ? 1 : 0.5;
			timeSavedMinutes += baseline.avgRetypeMinutesPerHit * factor;
		}
	}
	const timeSavedHours = timeSavedMinutes / 60;
	return {
		tmHits,
		aiCaughtIssues,
		timeSavedMinutes: Math.round(timeSavedMinutes * 100) / 100,
		timeSavedHours: Math.round(timeSavedHours * 1000) / 1000,
		moneySavedUsd: Math.round(timeSavedHours * HOURLY_RATE_USD * 100) / 100,
		hourlyRateUsd: HOURLY_RATE_USD,
	};
}

// ── Stores (file | postgres) ───────────────────────────────────────────────────

function normalizeEventInput(input: WorkEventInput): WorkEvent {
	const role = PERF_ROLES.includes(input.role) ? input.role : "translator";
	const weight = Number.isFinite(input.complexityWeight) && input.complexityWeight >= 0 ? input.complexityWeight : 1;
	return {
		id: input.id?.trim() || uuid(),
		workspaceId: input.workspaceId,
		userId: input.userId,
		projectId: input.projectId,
		role,
		eventType: input.eventType,
		complexityWeight: weight,
		durationMs: typeof input.durationMs === "number" && input.durationMs >= 0 ? Math.trunc(input.durationMs) : undefined,
		metadata: input.metadata,
		createdAt: input.createdAt ?? new Date().toISOString(),
	};
}

interface WorkEventSnapshot {
	events: WorkEvent[];
}

export class FilePerformanceMetricsStore implements PerformanceMetricsStore {
	private readonly events: WorkEvent[] = [];
	private readonly windowEventLimit: number;

	constructor(private readonly persistPath: string, windowEventLimit: number = serverConfig.performanceWindowEventLimit) {
		this.windowEventLimit = normalizeWindowEventLimit(windowEventLimit);
		this.load();
	}

	async recordEvent(input: WorkEventInput): Promise<WorkEvent> {
		const event = normalizeEventInput(input);
		// Idempotent ingestion: a retried request that reuses the same event id is a
		// no-op (returns the already-stored event) instead of double-counting.
		const existing = this.events.find((e) => e.id === event.id);
		if (existing) return existing;
		const previous = [...this.events];
		this.events.push(event);
		try {
			this.persist();
		} catch (error) {
			this.events.splice(0, this.events.length, ...previous);
			throw error;
		}
		return event;
	}

	async listEvents(query: WorkEventQuery): Promise<WorkEvent[]> {
		const limit = normalizeWorkEventReadLimit(query.limit, this.windowEventLimit);
		const order = query.order ?? "asc";
		const before = normalizeWorkEventCursor(query.before);
		const after = normalizeWorkEventCursor(query.after);
		const scoped = this.events
			.filter((e) => e.workspaceId === query.workspaceId)
			.filter((e) => !query.userId || e.userId === query.userId)
			.filter((e) => {
				const t = Date.parse(e.createdAt);
				if (query.since !== undefined && t < query.since) return false;
				if (query.until !== undefined && t > query.until) return false;
				if (before && compareWorkEventKey(e, before) >= 0) return false;
				if (after && compareWorkEventKey(e, after) <= 0) return false;
				return true;
			});
		return orderWorkEvents(scoped, order).slice(0, limit);
	}

	async listWorkspaceUserIds(workspaceId: string): Promise<string[]> {
		const ids = new Set<string>();
		for (const event of this.events) {
			if (event.workspaceId === workspaceId) ids.add(event.userId);
		}
		return [...ids];
	}

	async listWorkspaceWindowEvents(query: { workspaceId: string; since?: number; until?: number }): Promise<WorkspaceWindowEvents> {
		const capped = await listCappedWindowEvents(this, query, "file listWorkspaceWindowEvents");
		return groupWorkspaceWindowEvents(sortWorkspaceWindowEvents(capped.events), capped.truncated);
	}

	getWindowEventLimit(): number {
		return this.windowEventLimit;
	}

	private load(): void {
		if (!existsSync(this.persistPath)) return;
		try {
			const snapshot = readJsonFile<WorkEventSnapshot>(this.persistPath);
			if (Array.isArray(snapshot.events)) {
				this.events.splice(0, this.events.length, ...snapshot.events.filter(isWorkEvent));
			}
		} catch (error) {
			console.warn(`[PerformanceIntelligence] Failed to load ${this.persistPath}: ${error}`);
		}
	}

	private persist(): void {
		mkdirSync(join(this.persistPath, ".."), { recursive: true });
		writeFileSync(this.persistPath, JSON.stringify({ events: this.events }, null, 2));
	}
}

interface PerfSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	close?(): Promise<void> | void;
}

interface WorkEventRow {
	id: string;
	workspace_id: string;
	user_id: string;
	project_id: string | null;
	role: string;
	event_type: string;
	complexity_weight: number | string;
	duration_ms: number | string | null;
	metadata: unknown;
	created_at: Date | string;
}

export class PostgresPerformanceMetricsStore implements PerformanceMetricsStore {
	private readonly client: PerfSqlClient;
	/**
	 * Defensive cap on the grouped workspace-window read (see
	 * listWorkspaceWindowEvents). Defaults to the configured
	 * PERF_WINDOW_EVENT_LIMIT; overridable in tests to exercise truncation.
	 */
	private readonly windowEventLimit: number;

	constructor(
		databaseUrlOrClient: string | PerfSqlClient = process.env.DATABASE_URL ?? "",
		windowEventLimit: number = serverConfig.performanceWindowEventLimit,
	) {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new Error("PERFORMANCE_METRICS_STORE=postgres requires DATABASE_URL");
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as PerfSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
		this.windowEventLimit = normalizeWindowEventLimit(windowEventLimit);
	}

	async recordEvent(input: WorkEventInput): Promise<WorkEvent> {
		const event = normalizeEventInput(input);
		// ON CONFLICT (id) DO NOTHING makes ingestion idempotent: a retried request
		// that reuses the same caller-supplied event id is a no-op rather than a
		// duplicate that would double-count throughput/ROI/baseline samples.
		await this.client.unsafe(`
			INSERT INTO work_events (
				id, workspace_id, user_id, project_id, role, event_type,
				complexity_weight, duration_ms, metadata, created_at
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10)
			ON CONFLICT (id) DO NOTHING
		`, [
			event.id,
			event.workspaceId,
			event.userId,
			event.projectId ?? null,
			event.role,
			event.eventType,
			event.complexityWeight,
			event.durationMs ?? null,
			JSON.stringify(event.metadata ?? {}),
			event.createdAt,
		]);
		return event;
	}

	async listEvents(query: WorkEventQuery): Promise<WorkEvent[]> {
		const conditions = ["workspace_id = $1"];
		const params: unknown[] = [query.workspaceId];
		let next = 2;
		const before = normalizeWorkEventCursor(query.before);
		const after = normalizeWorkEventCursor(query.after);
		if (query.userId) {
			conditions.push(`user_id = $${next}`);
			params.push(query.userId);
			next += 1;
		}
		if (query.since !== undefined) {
			conditions.push(`created_at >= $${next}::timestamptz`);
			params.push(new Date(query.since).toISOString());
			next += 1;
		}
		if (query.until !== undefined) {
			conditions.push(`created_at <= $${next}::timestamptz`);
			params.push(new Date(query.until).toISOString());
			next += 1;
		}
		if (before) {
			conditions.push(`(created_at, id) < ($${next}::timestamptz, $${next + 1})`);
			params.push(before.createdAt, before.id);
			next += 2;
		}
		if (after) {
			conditions.push(`(created_at, id) > ($${next}::timestamptz, $${next + 1})`);
			params.push(after.createdAt, after.id);
			next += 2;
		}
		const limit = normalizeWorkEventReadLimit(query.limit, this.windowEventLimit);
		params.push(limit);
		const limitPlaceholder = `$${next}`;
		next += 1;
		const order = query.order === "desc" ? "DESC" : "ASC";
		const rows = await this.client.unsafe<WorkEventRow>(`
			SELECT id, workspace_id, user_id, project_id, role, event_type,
				complexity_weight, duration_ms, metadata, created_at
			FROM work_events
			WHERE ${conditions.join(" AND ")}
			ORDER BY created_at ${order}, id ${order}
			LIMIT ${limitPlaceholder}
		`, params);
		return rows.map(mapWorkEventRow);
	}

	async listWorkspaceUserIds(workspaceId: string): Promise<string[]> {
		const rows = await this.client.unsafe<{ user_id: string }>(`
			SELECT DISTINCT user_id FROM work_events WHERE workspace_id = $1
		`, [workspaceId]);
		return rows.map((row) => row.user_id);
	}

	async listWorkspaceWindowEvents(query: { workspaceId: string; since?: number; until?: number }): Promise<WorkspaceWindowEvents> {
		// rank8: ONE windowed, grouped read for the whole workspace instead of a
		// per-member listEvents loop + a separate full-window refetch. Bounded by
		// the [since, until] window (covered by work_events_workspace_created_idx);
		// ordered by user so each member's slice is contiguous, then by
		// (created_at, id) so each slice matches what the per-member query returned.
		//
		// perf: that window is otherwise UNBOUNDED — on an active workspace a
		// multi-week window selects every row and groups + scores them all in JS,
		// fully materializing an arbitrarily large set per dashboard load. We cap the
		// read at serverConfig.performanceWindowEventLimit. The cap keeps the window's
		// NEWEST rows (recent activity wins, and the scoring already EWMA-weights the
		// latest weeks most), so we order DESC + LIMIT in an inner select, then
		// re-order the kept slice ascending (user_id, created_at, id) in the outer
		// select to preserve the contiguous-per-user, time-ascending contract the
		// grouping + scoring layer depends on. When the slice truncates we log it so
		// an operator can raise PERF_WINDOW_EVENT_LIMIT for a genuinely huge workspace.
		const conditions = ["workspace_id = $1"];
		const params: unknown[] = [query.workspaceId];
		let next = 2;
		if (query.since !== undefined) {
			conditions.push(`created_at >= $${next}::timestamptz`);
			params.push(new Date(query.since).toISOString());
			next += 1;
		}
		if (query.until !== undefined) {
			conditions.push(`created_at <= $${next}::timestamptz`);
			params.push(new Date(query.until).toISOString());
			next += 1;
		}
		const limit = this.windowEventLimit;
		const fetchLimit = limit + 1;
		params.push(fetchLimit);
		const limitPlaceholder = `$${next}`;
		next += 1;
		const rows = await this.client.unsafe<WorkEventRow>(`
			SELECT id, workspace_id, user_id, project_id, role, event_type,
				complexity_weight, duration_ms, metadata, created_at
			FROM (
				SELECT id, workspace_id, user_id, project_id, role, event_type,
					complexity_weight, duration_ms, metadata, created_at
				FROM work_events
				WHERE ${conditions.join(" AND ")}
				ORDER BY created_at DESC, id DESC
				LIMIT ${limitPlaceholder}
			) AS recent
			ORDER BY user_id ASC, created_at ASC, id ASC
		`, params);
		const capped = capNewestEvents(rows.map(mapWorkEventRow), limit);
		if (capped.truncated) {
			// Fetching one sentinel beyond the cap proves older rows were dropped.
			// Older weeks contribute least to EWMA-smoothed scores, but log so the
			// cap can be raised for genuinely huge workspaces.
			warnWindowTruncated("postgres listWorkspaceWindowEvents", query, limit);
		}
		return groupWorkspaceWindowEvents(sortWorkspaceWindowEvents(capped.events), capped.truncated);
	}

	getWindowEventLimit(): number {
		return this.windowEventLimit;
	}
}

function mapWorkEventRow(row: WorkEventRow): WorkEvent {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		userId: row.user_id,
		projectId: row.project_id ?? undefined,
		role: (PERF_ROLES.includes(row.role as PerfRole) ? row.role : "translator") as PerfRole,
		eventType: row.event_type as PerfWorkEventType,
		complexityWeight: Number(row.complexity_weight),
		durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
		metadata: normalizeMetadata(row.metadata),
		createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
	};
}

function normalizeMetadata(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "string") {
		try {
			return normalizeMetadata(JSON.parse(value));
		} catch {
			return undefined;
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	return Object.keys(obj).length === 0 ? undefined : obj;
}

function isWorkEvent(value: unknown): value is WorkEvent {
	const event = value as Partial<WorkEvent>;
	return Boolean(
		event &&
		typeof event.id === "string" &&
		typeof event.workspaceId === "string" &&
		typeof event.userId === "string" &&
		typeof event.role === "string" &&
		typeof event.eventType === "string" &&
		typeof event.createdAt === "string",
	);
}

export function createPerformanceMetricsStore(): PerformanceMetricsStore {
	if (serverConfig.performanceMetricsStore === "postgres") {
		return new PostgresPerformanceMetricsStore();
	}
	return new FilePerformanceMetricsStore(join(DATA_DIR, "performance-metrics.json"));
}

export const performanceMetricsStore = createPerformanceMetricsStore();

// ── High-level service API ─────────────────────────────────────────────────────

export function isKnownWorkEventType(value: string): value is PerfWorkEventType {
	return (PERF_WORK_EVENT_TYPES as readonly string[]).includes(value);
}

export function isKnownPerfRole(value: string): value is PerfRole {
	return PERF_ROLES.includes(value as PerfRole);
}

export async function recordWorkEvent(input: WorkEventInput, store: PerformanceMetricsStore = performanceMetricsStore): Promise<WorkEvent> {
	return store.recordEvent(input);
}

export interface MemberPerformanceResult {
	scores: MemberScoreResult;
	baseline: BaselineComparison;
	roi: RoiMetrics;
	/**
	 * True when the member's current scoring window hit PERF_WINDOW_EVENT_LIMIT
	 * and older events were dropped before aggregation.
	 */
	windowTruncated: boolean;
	/**
	 * True when the previous self-comparison window was truncated. Kept separate
	 * because the current score may be complete while the historical baseline is
	 * recent-only.
	 */
	previousWindowTruncated: boolean;
	/**
	 * True when the workspace baseline population was computed from a capped
	 * recent-only slice.
	 */
	workspaceBaselineTruncated: boolean;
	windowEventLimit: number;
}

/** Compute one member's profile (scores + baseline comparison) within a workspace. */
export async function getMemberPerformance(
	options: {
		workspaceId: string;
		userId: string;
		role?: PerfRole;
		now?: number;
		periodWeeks?: number;
		includePlatformPercentile?: boolean;
		platformComposites?: number[] | null;
	},
	store: PerformanceMetricsStore = performanceMetricsStore,
): Promise<MemberPerformanceResult> {
	const now = options.now ?? Date.now();
	const periodWeeks = options.periodWeeks ?? DEFAULT_PERIOD_WEEKS;
	const windowStart = weekStart(now) - (periodWeeks - 1) * WEEK_MS;
	const prevWindowStart = windowStart - periodWeeks * WEEK_MS;

	// rank8: the current-window read, the preceding-window read (for the self-past
	// comparison), and the workspace-composite read are all independent — issue
	// them together instead of awaiting each sequentially. Safe here because
	// getMemberPerformance runs off the pooled connection, not inside a transaction.
	const [currentWindow, previousWindow, workspaceWindow] = await Promise.all([
		listCappedWindowEvents(
			store,
			{ workspaceId: options.workspaceId, userId: options.userId, since: windowStart, until: now },
			"member current window",
		),
		listCappedWindowEvents(
			store,
			{ workspaceId: options.workspaceId, userId: options.userId, since: prevWindowStart, until: windowStart - 1 },
			"member previous window",
		),
		collectWorkspaceComposites(options.workspaceId, { now, periodWeeks }, store),
	]);

	const events = currentWindow.events;
	const prevEvents = previousWindow.events;
	const scores = computeMemberScores(events, { workspaceId: options.workspaceId, userId: options.userId, role: options.role, now, periodWeeks });
	const prevScores = prevEvents.length > 0
		? computeMemberScores(prevEvents, { workspaceId: options.workspaceId, userId: options.userId, role: options.role ?? scores.role, now: windowStart - 1, periodWeeks })
		: null;

	const baseline = buildBaselineComparison({
		composite: scores.composite,
		selfPreviousComposite: prevScores ? prevScores.composite : null,
		workspaceComposites: workspaceWindow.composites,
		platformComposites: options.includePlatformPercentile ? (options.platformComposites ?? []) : null,
	});

	const roi = computeRoi(events, { now });
	return {
		scores,
		baseline,
		roi,
		windowTruncated: currentWindow.truncated,
		previousWindowTruncated: previousWindow.truncated,
		workspaceBaselineTruncated: workspaceWindow.windowTruncated,
		windowEventLimit: currentWindow.limit,
	};
}

interface WorkspaceCompositeWindow {
	composites: number[];
	windowTruncated: boolean;
	windowEventLimit: number;
}

async function collectWorkspaceComposites(
	workspaceId: string,
	options: { now: number; periodWeeks: number },
	store: PerformanceMetricsStore,
): Promise<WorkspaceCompositeWindow> {
	const windowStart = weekStart(options.now) - (options.periodWeeks - 1) * WEEK_MS;

	// rank8: one grouped workspace-window read replaces the per-member
	// listEvents N+1. Identical per-member composites: each member is scored from
	// exactly the same windowed event slice the per-user query would have returned.
	const grouped = await listWorkspaceWindowEventsCapped(store, { workspaceId, since: windowStart, until: options.now });
	const composites: number[] = [];
	for (const [userId, events] of grouped.byUser) {
		if (events.length === 0) continue;
		composites.push(computeMemberScores(events, { workspaceId, userId, now: options.now, periodWeeks: options.periodWeeks }).composite);
	}
	return {
		composites,
		windowTruncated: grouped.truncated,
		windowEventLimit: getStoreWindowEventLimit(store),
	};
}

export interface WorkspaceAggregate {
	workspaceId: string;
	periodStart: string;
	memberCount: number;
	medianComposite: number;
	dimensionMedians: Record<PerfDimension, number>;
	roi: RoiMetrics;
	computedAt: string;
	/**
	 * True when the underlying window scan hit PERF_WINDOW_EVENT_LIMIT and the
	 * OLDEST in-window events were dropped before aggregation. The medians / ROI
	 * above then reflect only the most recent `windowEventLimit` events, NOT the
	 * full period — older events and members active only in the dropped slice are
	 * absent. Surfaced so the UI can flag the figures as a recent-only window
	 * instead of silently presenting a truncated scan as complete.
	 */
	windowTruncated: boolean;
	/**
	 * The cap applied to the window scan (PERF_WINDOW_EVENT_LIMIT). Only
	 * meaningful when `windowTruncated` is true; lets the client show "showing the
	 * latest N events". Always present so the field shape is stable.
	 */
	windowEventLimit: number;
}

/** Workspace-wide aggregate (anonymized counts + medians). Visible to all members. */
export async function getWorkspaceAggregate(
	options: { workspaceId: string; now?: number; periodWeeks?: number },
	store: PerformanceMetricsStore = performanceMetricsStore,
): Promise<WorkspaceAggregate> {
	const now = options.now ?? Date.now();
	const periodWeeks = options.periodWeeks ?? DEFAULT_PERIOD_WEEKS;
	const windowStart = weekStart(now) - (periodWeeks - 1) * WEEK_MS;

	const composites: number[] = [];
	const dimensionValues: Record<PerfDimension, number[]> = {
		throughput: [], quality: [], consistency: [], ai_leverage: [], collaboration: [],
	};
	let memberCount = 0;

	// rank8: one grouped workspace-window read serves BOTH the per-member scores
	// and the workspace ROI. `all` is the same window the old code refetched
	// separately at the end (the duplicate full-window listEvents) — computed once,
	// reused here for computeRoi.
	let allEvents: WorkEvent[];
	// True when the window scan hit PERF_WINDOW_EVENT_LIMIT and dropped the oldest
	// events: the medians/ROI below then cover only a recent slice, not the full
	// period. Threaded into the result so the dashboard can flag it. Stores without
	// a grouped read still use one bounded workspace listEvents fallback.
	let windowTruncated = false;
	const grouped = await listWorkspaceWindowEventsCapped(store, { workspaceId: options.workspaceId, since: windowStart, until: now });
	allEvents = grouped.all;
	windowTruncated = grouped.truncated;
	for (const [userId, events] of grouped.byUser) {
		if (events.length === 0) continue;
		memberCount += 1;
		const scores = computeMemberScores(events, { workspaceId: options.workspaceId, userId, now, periodWeeks });
		composites.push(scores.composite);
		for (const dimension of PERF_DIMENSIONS) {
			dimensionValues[dimension].push(scores.dimensions[dimension].score);
		}
	}

	return {
		workspaceId: options.workspaceId,
		periodStart: new Date(windowStart).toISOString(),
		memberCount,
		medianComposite: clampScore(median(composites)),
		dimensionMedians: {
			throughput: clampScore(median(dimensionValues.throughput)),
			quality: clampScore(median(dimensionValues.quality)),
			consistency: clampScore(median(dimensionValues.consistency)),
			ai_leverage: clampScore(median(dimensionValues.ai_leverage)),
			collaboration: clampScore(median(dimensionValues.collaboration)),
		},
		roi: computeRoi(allEvents, { now }),
		computedAt: new Date(now).toISOString(),
		windowTruncated,
		windowEventLimit: getStoreWindowEventLimit(store),
	};
}

export interface RoiWindowResult {
	roi: RoiMetrics;
	windowTruncated: boolean;
	windowEventLimit: number;
}

/** ROI for one member (self) or the whole workspace. */
export async function getRoiWithWindow(
	options: { workspaceId: string; userId?: string; now?: number; periodWeeks?: number },
	store: PerformanceMetricsStore = performanceMetricsStore,
): Promise<RoiWindowResult> {
	const now = options.now ?? Date.now();
	const periodWeeks = options.periodWeeks ?? DEFAULT_PERIOD_WEEKS;
	const windowStart = weekStart(now) - (periodWeeks - 1) * WEEK_MS;
	const window = await listCappedWindowEvents(
		store,
		{ workspaceId: options.workspaceId, userId: options.userId, since: windowStart, until: now },
		"roi window",
	);
	return {
		roi: computeRoi(window.events, { now }),
		windowTruncated: window.truncated,
		windowEventLimit: window.limit,
	};
}

/** ROI for one member (self) or the whole workspace. */
export async function getRoi(
	options: { workspaceId: string; userId?: string; now?: number; periodWeeks?: number },
	store: PerformanceMetricsStore = performanceMetricsStore,
): Promise<RoiMetrics> {
	return (await getRoiWithWindow(options, store)).roi;
}
