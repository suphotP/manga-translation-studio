export type GuideOrientation = "vertical" | "horizontal";
export type SnapAxis = "x" | "y";
export type SnapSource = "guide" | "bounds" | "grid";
export type BoundsSnapKind = "left" | "center-x" | "right" | "top" | "center-y" | "bottom";
export type RulerTickKind = "major" | "minor";

export interface Point {
	x: number;
	y: number;
}

export interface Rect {
	id: string;
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface Guide {
	id: string;
	orientation: GuideOrientation;
	position: number;
}

export interface GuideSet {
	vertical: readonly Guide[];
	horizontal: readonly Guide[];
}

export interface SnapBounds {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface SnapOptions {
	guides: GuideSet;
	bounds: SnapBounds;
	gridSize?: number;
	threshold: number;
}

export interface SnapMatch {
	axis: SnapAxis;
	source: SnapSource;
	position: number;
	delta: number;
	distance: number;
	guideId?: string;
	orientation?: GuideOrientation;
	boundsKind?: BoundsSnapKind;
}

export interface SnapResult {
	point: Point;
	matches: readonly SnapMatch[];
}

export interface RulerTickOptions {
	start: number;
	end: number;
	zoom: number;
	minorPixelSpacing?: number;
	majorPixelSpacing?: number;
}

export interface RulerTick {
	kind: RulerTickKind;
	position: number;
	label?: string;
}

export interface RulerTickModel {
	minorStep: number;
	majorStep: number;
	ticks: readonly RulerTick[];
}

export interface SmartSpacingOptions {
	tolerance?: number;
}

export interface SmartSpacingGap {
	axis: SnapAxis;
	beforeId: string;
	afterId: string;
	from: number;
	to: number;
	distance: number;
	crossStart: number;
	crossEnd: number;
}

export interface SmartSpacingGuide {
	axis: SnapAxis;
	distance: number;
	gaps: readonly [SmartSpacingGap, SmartSpacingGap];
}

interface SnapCandidate {
	axis: SnapAxis;
	source: SnapSource;
	position: number;
	delta: number;
	distance: number;
	guideId?: string;
	orientation?: GuideOrientation;
	boundsKind?: BoundsSnapKind;
	priority: number;
}

interface NormalizedRect extends Rect {
	right: number;
	bottom: number;
}

const EMPTY_GUIDE_SET: GuideSet = Object.freeze({
	vertical: Object.freeze([]),
	horizontal: Object.freeze([]),
});

const SNAP_SOURCE_PRIORITY: Record<SnapSource, number> = {
	guide: 0,
	bounds: 1,
	grid: 2,
};

const NICE_STEP_MULTIPLIERS = [1, 2, 2.5, 5, 10] as const;
const EPSILON = 1e-9;

export function emptyGuideSet(): GuideSet {
	return EMPTY_GUIDE_SET;
}

export function addGuide(set: GuideSet, guide: Guide): GuideSet {
	const normalized = normalizeGuide(guide);
	if (!normalized) return set;
	const withoutExisting = removeGuideById(set, normalized.id);
	return normalizeGuideSet({
		...withoutExisting,
		[normalized.orientation]: [...withoutExisting[normalized.orientation], normalized],
	});
}

export function dragGuide(set: GuideSet, id: string, position: number): GuideSet {
	if (!id || !isFiniteNumber(position)) return set;
	const existing = findGuide(set, id);
	if (!existing) return set;
	return normalizeGuideSet({
		vertical: set.vertical.map((guide) => (guide.id === id ? { ...guide, position } : guide)),
		horizontal: set.horizontal.map((guide) => (guide.id === id ? { ...guide, position } : guide)),
	});
}

export function deleteGuide(set: GuideSet, id: string): GuideSet {
	if (!id) return set;
	return removeGuideById(set, id);
}

export function snap(point: Point, options: SnapOptions): SnapResult {
	if (!isFinitePoint(point)) return { point, matches: [] };
	const threshold = Math.max(0, options.threshold);
	const xCandidate = pickClosestSnapCandidate(buildSnapCandidatesForAxis(point, options, "x", threshold));
	const yCandidate = pickClosestSnapCandidate(buildSnapCandidatesForAxis(point, options, "y", threshold));
	const matches = [xCandidate, yCandidate].filter((candidate): candidate is SnapCandidate => candidate !== null).map(toSnapMatch);

	return {
		point: {
			x: xCandidate ? xCandidate.position : point.x,
			y: yCandidate ? yCandidate.position : point.y,
		},
		matches,
	};
}

export function buildRulerTicks(options: RulerTickOptions): RulerTickModel {
	if (!isFiniteNumber(options.start) || !isFiniteNumber(options.end) || !isFiniteNumber(options.zoom) || options.zoom <= 0) {
		return { minorStep: 0, majorStep: 0, ticks: [] };
	}

	const start = Math.min(options.start, options.end);
	const end = Math.max(options.start, options.end);
	const minorPixelSpacing = positiveOrDefault(options.minorPixelSpacing, 8);
	const majorPixelSpacing = positiveOrDefault(options.majorPixelSpacing, 40);
	const minorStep = pickNiceStep(minorPixelSpacing / options.zoom);
	// Major ticks use a separate nice step so labels stay readable as zoom changes.
	const majorStep = pickNiceStep(Math.max(majorPixelSpacing / options.zoom, minorStep * 5));
	const firstTick = Math.ceil((start - EPSILON) / minorStep) * minorStep;
	const ticks: RulerTick[] = [];

	for (let position = firstTick; position <= end + EPSILON; position += minorStep) {
		const normalizedPosition = normalizeFloat(position);
		const major = isMultipleOfStep(normalizedPosition, majorStep);
		ticks.push({
			kind: major ? "major" : "minor",
			position: normalizedPosition,
			...(major ? { label: formatTickLabel(normalizedPosition) } : {}),
		});
	}

	return { minorStep, majorStep, ticks };
}

export function findSmartSpacingGuides(rects: readonly Rect[], options: SmartSpacingOptions = {}): SmartSpacingGuide[] {
	const tolerance = Math.max(0, options.tolerance ?? 0.5);
	const normalized = rects.map(normalizeRect).filter((rect): rect is NormalizedRect => rect !== null);
	if (normalized.length < 3) return [];

	return [
		...findEqualSpacingForAxis(normalized, "x", tolerance),
		...findEqualSpacingForAxis(normalized, "y", tolerance),
	].sort(compareSmartSpacingGuides);
}

function normalizeGuideSet(set: GuideSet): GuideSet {
	return {
		vertical: sortGuides(set.vertical.map(normalizeGuide).filter((guide): guide is Guide => guide !== null)),
		horizontal: sortGuides(set.horizontal.map(normalizeGuide).filter((guide): guide is Guide => guide !== null)),
	};
}

function normalizeGuide(guide: Guide): Guide | null {
	if (!guide.id || !isFiniteNumber(guide.position)) return null;
	return {
		id: guide.id,
		orientation: guide.orientation,
		position: normalizeFloat(guide.position),
	};
}

function sortGuides(guides: readonly Guide[]): Guide[] {
	return [...guides].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

function findGuide(set: GuideSet, id: string): Guide | null {
	return set.vertical.find((guide) => guide.id === id) ?? set.horizontal.find((guide) => guide.id === id) ?? null;
}

function removeGuideById(set: GuideSet, id: string): GuideSet {
	const vertical = set.vertical.filter((guide) => guide.id !== id);
	const horizontal = set.horizontal.filter((guide) => guide.id !== id);
	if (vertical.length === set.vertical.length && horizontal.length === set.horizontal.length) return set;
	return normalizeGuideSet({ vertical, horizontal });
}

function buildSnapCandidatesForAxis(point: Point, options: SnapOptions, axis: SnapAxis, threshold: number): SnapCandidate[] {
	const value = axis === "x" ? point.x : point.y;
	const candidates: SnapCandidate[] = [];

	for (const guide of axis === "x" ? options.guides.vertical : options.guides.horizontal) {
		if (!isFiniteNumber(guide.position)) continue;
		candidates.push(makeSnapCandidate(axis, "guide", value, guide.position, {
			guideId: guide.id,
			orientation: guide.orientation,
		}));
	}

	const bounds = normalizeBounds(options.bounds);
	if (bounds) {
		for (const target of buildBoundsTargets(bounds, axis)) {
			candidates.push(makeSnapCandidate(axis, "bounds", value, target.position, { boundsKind: target.kind }));
		}
	}

	if (isFiniteNumber(options.gridSize) && options.gridSize > 0) {
		const position = normalizeFloat(Math.round(value / options.gridSize) * options.gridSize);
		candidates.push(makeSnapCandidate(axis, "grid", value, position));
	}

	return candidates.filter((candidate) => candidate.distance <= threshold);
}

function makeSnapCandidate(
	axis: SnapAxis,
	source: SnapSource,
	value: number,
	position: number,
	extras: Pick<SnapCandidate, "guideId" | "orientation" | "boundsKind"> = {},
): SnapCandidate {
	const delta = normalizeFloat(position - value);
	return {
		axis,
		source,
		position: normalizeFloat(position),
		delta,
		distance: Math.abs(delta),
		priority: SNAP_SOURCE_PRIORITY[source],
		...extras,
	};
}

function pickClosestSnapCandidate(candidates: readonly SnapCandidate[]): SnapCandidate | null {
	let best: SnapCandidate | null = null;
	for (const candidate of candidates) {
		if (
			!best ||
			candidate.distance < best.distance ||
			(approximatelyEqual(candidate.distance, best.distance) && compareSnapCandidates(candidate, best) < 0)
		) {
			best = candidate;
		}
	}
	return best;
}

function compareSnapCandidates(a: SnapCandidate, b: SnapCandidate): number {
	return a.priority - b.priority || a.position - b.position || (a.guideId ?? "").localeCompare(b.guideId ?? "");
}

function toSnapMatch(candidate: SnapCandidate): SnapMatch {
	return {
		axis: candidate.axis,
		source: candidate.source,
		position: candidate.position,
		delta: candidate.delta,
		distance: candidate.distance,
		...(candidate.guideId ? { guideId: candidate.guideId } : {}),
		...(candidate.orientation ? { orientation: candidate.orientation } : {}),
		...(candidate.boundsKind ? { boundsKind: candidate.boundsKind } : {}),
	};
}

function normalizeBounds(bounds: SnapBounds): SnapBounds | null {
	if (
		!isFiniteNumber(bounds.left) ||
		!isFiniteNumber(bounds.top) ||
		!isFiniteNumber(bounds.width) ||
		!isFiniteNumber(bounds.height) ||
		bounds.width < 0 ||
		bounds.height < 0
	) {
		return null;
	}
	return {
		left: normalizeFloat(bounds.left),
		top: normalizeFloat(bounds.top),
		width: normalizeFloat(bounds.width),
		height: normalizeFloat(bounds.height),
	};
}

function buildBoundsTargets(bounds: SnapBounds, axis: SnapAxis): { kind: BoundsSnapKind; position: number }[] {
	if (axis === "x") {
		return [
			{ kind: "left", position: bounds.left },
			{ kind: "center-x", position: bounds.left + bounds.width / 2 },
			{ kind: "right", position: bounds.left + bounds.width },
		];
	}
	return [
		{ kind: "top", position: bounds.top },
		{ kind: "center-y", position: bounds.top + bounds.height / 2 },
		{ kind: "bottom", position: bounds.top + bounds.height },
	];
}

function pickNiceStep(minimumStep: number): number {
	if (!isFiniteNumber(minimumStep) || minimumStep <= 0) return 1;
	const exponent = Math.floor(Math.log10(minimumStep));
	const base = 10 ** exponent;
	for (const multiplier of NICE_STEP_MULTIPLIERS) {
		const step = multiplier * base;
		if (step >= minimumStep - EPSILON) return normalizeFloat(step);
	}
	return normalizeFloat(10 * base);
}

function isMultipleOfStep(value: number, step: number): boolean {
	if (!isFiniteNumber(step) || step <= 0) return false;
	return approximatelyEqual(value / step, Math.round(value / step));
}

function formatTickLabel(value: number): string {
	const normalized = normalizeFloat(value);
	return Object.is(normalized, -0) ? "0" : String(normalized);
}

function findEqualSpacingForAxis(rects: readonly NormalizedRect[], axis: SnapAxis, tolerance: number): SmartSpacingGuide[] {
	const gaps = buildSpacingGaps(rects, axis);
	const guides: SmartSpacingGuide[] = [];
	for (let i = 0; i < gaps.length; i += 1) {
		const first = gaps[i];
		for (let j = i + 1; j < gaps.length; j += 1) {
			const second = gaps[j];
			if (Math.abs(first.distance - second.distance) <= tolerance) {
				guides.push({
					axis,
					distance: normalizeFloat((first.distance + second.distance) / 2),
					gaps: [first, second],
				});
			}
		}
	}
	return guides;
}

function buildSpacingGaps(rects: readonly NormalizedRect[], axis: SnapAxis): SmartSpacingGap[] {
	const sorted = [...rects].sort((a, b) => {
		const primary = axis === "x" ? a.left - b.left || a.right - b.right : a.top - b.top || a.bottom - b.bottom;
		return primary || a.id.localeCompare(b.id);
	});
	const gaps: SmartSpacingGap[] = [];
	for (let i = 0; i < sorted.length - 1; i += 1) {
		const before = sorted[i];
		const after = sorted[i + 1];
		const from = axis === "x" ? before.right : before.bottom;
		const to = axis === "x" ? after.left : after.top;
		const distance = normalizeFloat(to - from);
		if (distance < 0) continue;
		gaps.push({
			axis,
			beforeId: before.id,
			afterId: after.id,
			from: normalizeFloat(from),
			to: normalizeFloat(to),
			distance,
			// Perpendicular span lets the UI draw spacing brackets without reading the source rects again.
			crossStart: normalizeFloat(Math.min(axis === "x" ? before.top : before.left, axis === "x" ? after.top : after.left)),
			crossEnd: normalizeFloat(Math.max(axis === "x" ? before.bottom : before.right, axis === "x" ? after.bottom : after.right)),
		});
	}
	return gaps;
}

function compareSmartSpacingGuides(a: SmartSpacingGuide, b: SmartSpacingGuide): number {
	return (
		a.axis.localeCompare(b.axis) ||
		a.distance - b.distance ||
		a.gaps[0].beforeId.localeCompare(b.gaps[0].beforeId) ||
		a.gaps[0].afterId.localeCompare(b.gaps[0].afterId) ||
		a.gaps[1].beforeId.localeCompare(b.gaps[1].beforeId) ||
		a.gaps[1].afterId.localeCompare(b.gaps[1].afterId)
	);
}

function normalizeRect(rect: Rect): NormalizedRect | null {
	if (
		!rect.id ||
		!isFiniteNumber(rect.left) ||
		!isFiniteNumber(rect.top) ||
		!isFiniteNumber(rect.width) ||
		!isFiniteNumber(rect.height) ||
		rect.width < 0 ||
		rect.height < 0
	) {
		return null;
	}
	const left = normalizeFloat(rect.left);
	const top = normalizeFloat(rect.top);
	const width = normalizeFloat(rect.width);
	const height = normalizeFloat(rect.height);
	const right = normalizeFloat(left + width);
	const bottom = normalizeFloat(top + height);
	return {
		id: rect.id,
		left,
		top,
		width,
		height,
		right,
		bottom,
	};
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
	return isFiniteNumber(value) && value > 0 ? value : fallback;
}

function isFinitePoint(point: Point): boolean {
	return isFiniteNumber(point.x) && isFiniteNumber(point.y);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function approximatelyEqual(a: number, b: number): boolean {
	return Math.abs(a - b) <= EPSILON;
}

function normalizeFloat(value: number): number {
	const normalized = Number(value.toFixed(9));
	return Object.is(normalized, -0) ? 0 : normalized;
}
