export interface BrushSettings {
	size: number;
	hardness: number;
	opacity: number;
	flow: number;
	spacingPct: number;
	stabilizer: number;
}

export interface BrushPointerEvent {
	x: number;
	y: number;
	pressure?: number;
	t: number;
}

export interface BrushDab {
	x: number;
	y: number;
	t: number;
	pressure: number;
	size: number;
}

export interface BrushCompositeOptions {
	width: number;
	height: number;
	layer: Uint8ClampedArray;
	dabs: readonly BrushDab[];
	settings: BrushSettings;
	color?: readonly [number, number, number, number];
}

export interface BrushCompositeResult {
	layer: Uint8ClampedArray;
	strokeAlpha: Float32Array;
}

interface NormalizedBrushSettings {
	size: number;
	hardness: number;
	opacity: number;
	flow: number;
	spacingPx: number;
	stabilizer: number;
}

interface StrokeSample {
	x: number;
	y: number;
	t: number;
	pressure: number;
}

const MIN_BRUSH_SIZE = 1;
const MIN_SPACING_PX = 0.25;
const DEFAULT_DAB_COLOR = [0, 0, 0, 255] as const;
const alphaMapCache = new Map<string, Float32Array>();

// Keep this engine DOM/Fabric-free so image-space brush behavior can be reused by
// the editor, worker-side previews, and tests without coupling to canvas state.
export function strokePlanner(events: readonly BrushPointerEvent[], settings: BrushSettings): BrushDab[] {
	if (events.length === 0) return [];

	const normalized = normalizeSettings(settings);
	const stabilized = stabilizePointerEvents(events, normalized.stabilizer);
	if (stabilized.length === 1) return [sampleToDab(stabilized[0], normalized.size)];

	const path = catmullRomPath(stabilized, normalized.spacingPx);
	if (path.length === 0) return [];

	const dabs: BrushDab[] = [sampleToDab(path[0], normalized.size)];
	let distanceSinceLast = 0;

	for (let i = 1; i < path.length; i++) {
		let cursor = path[i - 1];
		const end = path[i];
		let remaining = distance(cursor, end);
		if (remaining <= 0) continue;

		while (distanceSinceLast + remaining >= normalized.spacingPx) {
			const need = normalized.spacingPx - distanceSinceLast;
			const ratio = need / remaining;
			const dabSample = lerpSample(cursor, end, ratio);
			dabs.push(sampleToDab(dabSample, normalized.size));
			cursor = dabSample;
			remaining = distance(cursor, end);
			distanceSinceLast = 0;
			if (remaining <= 0) break;
		}
		distanceSinceLast += remaining;
	}

	return dabs;
}

export function dabAlphaMap(size: number, hardness: number): Float32Array {
	const diameter = normalizeDiameter(size);
	const normalizedHardness = clamp01(hardness);
	const hardnessKey = Math.round(normalizedHardness * 1000);
	const key = `${diameter}:${hardnessKey}`;
	const cached = alphaMapCache.get(key);
	if (cached) return cached;

	const alpha = new Float32Array(diameter * diameter);
	const center = (diameter - 1) / 2;
	const radius = Math.max(0.5, diameter / 2);
	const innerRadius = normalizedHardness;

	for (let y = 0; y < diameter; y++) {
		for (let x = 0; x < diameter; x++) {
			const dx = x - center;
			const dy = y - center;
			const unitDistance = Math.sqrt(dx * dx + dy * dy) / radius;
			alpha[y * diameter + x] = hardnessFalloff(unitDistance, innerRadius);
		}
	}

	alphaMapCache.set(key, alpha);
	return alpha;
}

export function compositeDabs({
	width,
	height,
	layer,
	dabs,
	settings,
	color = DEFAULT_DAB_COLOR,
}: BrushCompositeOptions): BrushCompositeResult {
	const w = Math.max(0, Math.floor(width));
	const h = Math.max(0, Math.floor(height));
	const pixelCount = w * h;
	const expectedLength = pixelCount * 4;
	if (layer.length !== expectedLength) {
		throw new Error(`compositeDabs: expected ${expectedLength} RGBA bytes, got ${layer.length}`);
	}

	const normalized = normalizeSettings(settings);
	const strokeCoverage = new Float32Array(pixelCount);

	for (const dab of dabs) {
		if (!Number.isFinite(dab.x) || !Number.isFinite(dab.y)) continue;
		const pressure = clamp01(dab.pressure);
		if (pressure <= 0) continue;

		const dabSize = Math.max(MIN_BRUSH_SIZE, Number.isFinite(dab.size) ? dab.size : normalized.size);
		const diameter = normalizeDiameter(dabSize);
		const map = dabAlphaMap(dabSize, normalized.hardness);
		const center = (diameter - 1) / 2;
		const x0 = Math.round(dab.x - center);
		const y0 = Math.round(dab.y - center);
		const dabFlow = normalized.flow * pressure;

		for (let my = 0; my < diameter; my++) {
			const y = y0 + my;
			if (y < 0 || y >= h) continue;
			for (let mx = 0; mx < diameter; mx++) {
				const x = x0 + mx;
				if (x < 0 || x >= w) continue;
				const maskAlpha = map[my * diameter + mx] * dabFlow;
				if (maskAlpha <= 0) continue;

				const index = y * w + x;
				// Flow accumulates per dab, but opacity is a stroke-level ceiling; the
				// separate buffer prevents repeated dabs from exceeding the user's cap.
				const next = strokeCoverage[index] + maskAlpha * (1 - strokeCoverage[index]);
				strokeCoverage[index] = next > normalized.opacity ? normalized.opacity : next;
			}
		}
	}

	const out = layer.slice();
	const sourceAlphaScale = clamp01(color[3] / 255);
	for (let i = 0; i < pixelCount; i++) {
		const strokeAlpha = strokeCoverage[i] * sourceAlphaScale;
		if (strokeAlpha <= 0) continue;
		sourceOver(out, i * 4, color, strokeAlpha);
	}

	return { layer: out, strokeAlpha: strokeCoverage };
}

export function clearDabAlphaMapCache(): void {
	alphaMapCache.clear();
}

function normalizeSettings(settings: BrushSettings): NormalizedBrushSettings {
	const size = Math.max(MIN_BRUSH_SIZE, finiteOr(settings.size, MIN_BRUSH_SIZE));
	const spacingPct = Math.max(1, finiteOr(settings.spacingPct, 1));
	return {
		size,
		hardness: clamp01(settings.hardness),
		opacity: clamp01(settings.opacity),
		flow: clamp01(settings.flow),
		spacingPx: Math.max(MIN_SPACING_PX, (size * spacingPct) / 100),
		stabilizer: clamp01(settings.stabilizer),
	};
}

function stabilizePointerEvents(
	events: readonly BrushPointerEvent[],
	stabilizer: number,
): StrokeSample[] {
	const samples: StrokeSample[] = [];
	let previous: StrokeSample | null = null;
	const follow = 1 - stabilizer;

	for (const event of events) {
		if (!Number.isFinite(event.x) || !Number.isFinite(event.y) || !Number.isFinite(event.t)) continue;
		const raw: StrokeSample = {
			x: event.x,
			y: event.y,
			t: event.t,
			pressure: normalizePressure(event.pressure),
		};
		if (!previous) {
			previous = raw;
			samples.push(raw);
			continue;
		}

		// Stabilization must happen before curve planning; otherwise the curve can
		// preserve small pointer jitters as extra path length and over-stamp a stroke.
		const smoothed: StrokeSample = {
			x: previous.x + (raw.x - previous.x) * follow,
			y: previous.y + (raw.y - previous.y) * follow,
			t: raw.t,
			pressure: raw.pressure,
		};
		previous = smoothed;
		samples.push(smoothed);
	}

	return samples;
}

function catmullRomPath(samples: readonly StrokeSample[], spacingPx: number): StrokeSample[] {
	if (samples.length <= 1) return [...samples];

	const path: StrokeSample[] = [samples[0]];
	const sampleStep = Math.max(MIN_SPACING_PX, spacingPx / 2);
	for (let i = 0; i < samples.length - 1; i++) {
		const p0 = samples[Math.max(0, i - 1)];
		const p1 = samples[i];
		const p2 = samples[i + 1];
		const p3 = samples[Math.min(samples.length - 1, i + 2)];
		const segmentDistance = Math.max(MIN_SPACING_PX, distance(p1, p2));
		const steps = Math.max(4, Math.ceil(segmentDistance / sampleStep));

		for (let step = 1; step <= steps; step++) {
			const u = step / steps;
			path.push({
				x: catmullRom(p0.x, p1.x, p2.x, p3.x, u),
				y: catmullRom(p0.y, p1.y, p2.y, p3.y, u),
				t: linear(p1.t, p2.t, u),
				pressure: clamp01(catmullRom(p0.pressure, p1.pressure, p2.pressure, p3.pressure, u)),
			});
		}
	}
	return path;
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, u: number): number {
	const u2 = u * u;
	const u3 = u2 * u;
	return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

function sourceOver(
	data: Uint8ClampedArray,
	offset: number,
	color: readonly [number, number, number, number],
	sourceAlpha: number,
): void {
	const dstAlpha = data[offset + 3] / 255;
	const outAlpha = sourceAlpha + dstAlpha * (1 - sourceAlpha);
	if (outAlpha <= 0) {
		data[offset] = 0;
		data[offset + 1] = 0;
		data[offset + 2] = 0;
		data[offset + 3] = 0;
		return;
	}

	data[offset] = Math.round((color[0] * sourceAlpha + data[offset] * dstAlpha * (1 - sourceAlpha)) / outAlpha);
	data[offset + 1] = Math.round((color[1] * sourceAlpha + data[offset + 1] * dstAlpha * (1 - sourceAlpha)) / outAlpha);
	data[offset + 2] = Math.round((color[2] * sourceAlpha + data[offset + 2] * dstAlpha * (1 - sourceAlpha)) / outAlpha);
	data[offset + 3] = Math.round(outAlpha * 255);
}

function sampleToDab(sample: StrokeSample, size: number): BrushDab {
	return { x: sample.x, y: sample.y, t: sample.t, pressure: sample.pressure, size };
}

function lerpSample(a: StrokeSample, b: StrokeSample, ratio: number): StrokeSample {
	return {
		x: linear(a.x, b.x, ratio),
		y: linear(a.y, b.y, ratio),
		t: linear(a.t, b.t, ratio),
		pressure: linear(a.pressure, b.pressure, ratio),
	};
}

function linear(a: number, b: number, ratio: number): number {
	return a + (b - a) * ratio;
}

function distance(a: Pick<StrokeSample, "x" | "y">, b: Pick<StrokeSample, "x" | "y">): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	return Math.sqrt(dx * dx + dy * dy);
}

function hardnessFalloff(unitDistance: number, hardness: number): number {
	if (unitDistance > 1) return 0;
	if (hardness >= 1) return 1;
	if (unitDistance <= hardness) return 1;
	const feather = 1 - hardness;
	if (feather <= 0) return 1;
	const soft = 1 - (unitDistance - hardness) / feather;
	return clamp01(soft);
}

function normalizeDiameter(size: number): number {
	return Math.max(MIN_BRUSH_SIZE, Math.ceil(finiteOr(size, MIN_BRUSH_SIZE)));
}

function normalizePressure(pressure: number | undefined): number {
	return pressure === undefined ? 1 : clamp01(pressure);
}

function finiteOr(value: number, fallback: number): number {
	return Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value <= 0) return 0;
	if (value >= 1) return 1;
	return value;
}
