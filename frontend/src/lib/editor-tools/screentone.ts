export type ScreentoneType = "dot" | "line" | "cross" | "noise";

export interface ToneOptions {
	type: ScreentoneType;
	density: number;
	sizePx: number;
	angleDeg?: number;
}

export interface GradientToneOptions extends ToneOptions {
	fromDensity?: number;
	toDensity?: number;
	axisDeg?: number;
}

export interface ImageDataLike {
	width: number;
	height: number;
	data: Uint8ClampedArray;
}

interface NormalizedToneOptions {
	type: ScreentoneType;
	density: number;
	sizePx: number;
	angleDeg: number;
}

interface ToneDimensions {
	width: number;
	height: number;
	total: number;
}

interface LatticeVector {
	x: number;
	y: number;
}

interface Cutoff {
	bucket: number;
	neededInBucket: number;
	bucketCount: number;
}

const SCORE_BUCKET_COUNT = 65_536;
const MAX_SCORE_BUCKET = SCORE_BUCKET_COUNT - 1;
const TIE_JITTER_WEIGHT = 0.001;
const HASH_UNIT = 1 / 0x1_0000_0000;

const TYPE_SALT: Record<ScreentoneType, number> = {
	dot: 0x6d2b_79f5,
	line: 0x1b87_3593,
	cross: 0x85eb_ca6b,
	noise: 0xc2b2_ae35,
};

function normalizeDimensions(width: number, height: number): ToneDimensions {
	const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	const h = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
	return { width: w, height: h, total: w * h };
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value <= 0) return 0;
	if (value >= 1) return 1;
	return value;
}

function normalizeToneOptions(options: ToneOptions): NormalizedToneOptions {
	if (options.type !== "dot" && options.type !== "line" && options.type !== "cross" && options.type !== "noise") {
		throw new Error(`Unsupported screentone type: ${String(options.type)}`);
	}
	const sizePx = Number.isFinite(options.sizePx) ? Math.max(1, options.sizePx) : 1;
	const angleDeg = Number.isFinite(options.angleDeg) ? (options.angleDeg ?? 0) : 0;
	return {
		type: options.type,
		density: clamp01(options.density),
		sizePx,
		angleDeg,
	};
}

function normalizedCoordinate(index: number, size: number): number {
	return size <= 1 ? 0 : index / (size - 1);
}

function canonicalEdgeIndex(index: number, size: number): number {
	return size > 1 && index === size - 1 ? 0 : index;
}

function fract(value: number): number {
	return value - Math.floor(value);
}

function stripeDistance(phase: number): number {
	const wrapped = fract(phase);
	return Math.min(wrapped, 1 - wrapped) * 2;
}

function centeredCellCoordinate(phase: number): number {
	return (fract(phase) - 0.5) * 2;
}

function hashUint32(x: number, y: number, salt: number): number {
	let h = Math.imul(x ^ salt, 0x85eb_ca6b) ^ Math.imul(y + 0x9e37_79b9, 0xc2b2_ae35);
	h ^= h >>> 16;
	h = Math.imul(h, 0x7feb_352d);
	h ^= h >>> 15;
	h = Math.imul(h, 0x846c_a68b);
	h ^= h >>> 16;
	return h >>> 0;
}

function hashUnit(x: number, y: number, salt: number): number {
	return hashUint32(x, y, salt) * HASH_UNIT;
}

function latticeVector(width: number, height: number, sizePx: number, angleDeg: number): LatticeVector {
	const rad = (angleDeg * Math.PI) / 180;
	const spanX = Math.max(1, width - 1);
	const spanY = Math.max(1, height - 1);
	let x = Math.round((Math.cos(rad) * spanX) / sizePx);
	let y = Math.round((Math.sin(rad) * spanY) / sizePx);
	if (x === 0 && y === 0) {
		if (Math.abs(Math.cos(rad)) * spanX >= Math.abs(Math.sin(rad)) * spanY) {
			x = Math.cos(rad) < 0 ? -1 : 1;
		} else {
			y = Math.sin(rad) < 0 ? -1 : 1;
		}
	}
	return { x, y };
}

function scoreWithTieJitter(score: number, x: number, y: number, dims: ToneDimensions, salt: number): number {
	const cx = canonicalEdgeIndex(x, dims.width);
	const cy = canonicalEdgeIndex(y, dims.height);
	const jitter = hashUnit(cx, cy, salt ^ 0xa511_e9b3);
	const clamped = clamp01(score);
	// Equal geometric scores are common in line art. A tiny deterministic jitter
	// prevents whole rows from flipping together while keeping matching tile edges identical.
	return Math.min(1, clamped * (1 - TIE_JITTER_WEIGHT) + jitter * TIE_JITTER_WEIGHT);
}

function toneScoreBucket(x: number, y: number, dims: ToneDimensions, options: NormalizedToneOptions): number {
	const cx = canonicalEdgeIndex(x, dims.width);
	const cy = canonicalEdgeIndex(y, dims.height);
	if (options.type === "noise") {
		return Math.min(MAX_SCORE_BUCKET, Math.floor(hashUnit(cx, cy, TYPE_SALT.noise) * SCORE_BUCKET_COUNT));
	}

	const u = normalizedCoordinate(x, dims.width);
	const v = normalizedCoordinate(y, dims.height);
	let score: number;

	if (options.type === "line") {
		const normal = latticeVector(dims.width, dims.height, options.sizePx, options.angleDeg + 90);
		score = stripeDistance(normal.x * u + normal.y * v);
	} else if (options.type === "cross") {
		const normalA = latticeVector(dims.width, dims.height, options.sizePx, options.angleDeg + 90);
		const normalB = latticeVector(dims.width, dims.height, options.sizePx, options.angleDeg);
		score = Math.min(stripeDistance(normalA.x * u + normalA.y * v), stripeDistance(normalB.x * u + normalB.y * v));
	} else {
		const axisA = latticeVector(dims.width, dims.height, options.sizePx, options.angleDeg);
		const axisB = latticeVector(dims.width, dims.height, options.sizePx, options.angleDeg + 90);
		const dx = centeredCellCoordinate(axisA.x * u + axisA.y * v);
		const dy = centeredCellCoordinate(axisB.x * u + axisB.y * v);
		score = Math.min(1, Math.hypot(dx, dy) / Math.SQRT2);
	}

	const jittered = scoreWithTieJitter(score, x, y, dims, TYPE_SALT[options.type]);
	return Math.min(MAX_SCORE_BUCKET, Math.floor(jittered * SCORE_BUCKET_COUNT));
}

function buildScoreHistogram(dims: ToneDimensions, options: NormalizedToneOptions): Uint32Array {
	const histogram = new Uint32Array(SCORE_BUCKET_COUNT);
	for (let y = 0; y < dims.height; y++) {
		for (let x = 0; x < dims.width; x++) {
			histogram[toneScoreBucket(x, y, dims, options)]++;
		}
	}
	return histogram;
}

function cutoffForDensity(histogram: Uint32Array, total: number, density: number): Cutoff {
	const desired = Math.round(clamp01(density) * total);
	if (desired <= 0) return { bucket: -1, neededInBucket: 0, bucketCount: 0 };
	if (desired >= total) return { bucket: MAX_SCORE_BUCKET, neededInBucket: total, bucketCount: total };

	let below = 0;
	for (let bucket = 0; bucket < histogram.length; bucket++) {
		const count = histogram[bucket];
		if (below + count >= desired) {
			return { bucket, neededInBucket: desired - below, bucketCount: count };
		}
		below += count;
	}
	return { bucket: MAX_SCORE_BUCKET, neededInBucket: total, bucketCount: total };
}

function canonicalPixelKey(x: number, y: number, dims: ToneDimensions): number {
	const cx = canonicalEdgeIndex(x, dims.width);
	const cy = canonicalEdgeIndex(y, dims.height);
	return cy * dims.width + cx;
}

function selectCutoffKeys(dims: ToneDimensions, options: NormalizedToneOptions, cutoff: Cutoff): Set<number> {
	const groups = new Map<number, number>();
	for (let y = 0; y < dims.height; y++) {
		for (let x = 0; x < dims.width; x++) {
			if (toneScoreBucket(x, y, dims, options) !== cutoff.bucket) continue;
			const key = canonicalPixelKey(x, y, dims);
			groups.set(key, (groups.get(key) ?? 0) + 1);
		}
	}

	const ordered = [...groups.entries()].sort(([keyA], [keyB]) => {
		const ax = keyA % dims.width;
		const ay = Math.floor(keyA / dims.width);
		const bx = keyB % dims.width;
		const by = Math.floor(keyB / dims.width);
		const hashA = hashUint32(ax, ay, 0x4cf5_ad43);
		const hashB = hashUint32(bx, by, 0x4cf5_ad43);
		return hashA === hashB ? keyA - keyB : hashA - hashB;
	});

	const selected = new Set<number>();
	let selectedCount = 0;
	for (const [key, count] of ordered) {
		if (selectedCount + count <= cutoff.neededInBucket) {
			selected.add(key);
			selectedCount += count;
			continue;
		}
		// Edge groups can contain two or four pixels. Pick the closer count so the
		// density stays accurate without splitting a seam-matched edge pair.
		const without = Math.abs(cutoff.neededInBucket - selectedCount);
		const withGroup = Math.abs(cutoff.neededInBucket - (selectedCount + count));
		if (withGroup < without) {
			selected.add(key);
			selectedCount += count;
		}
		if (selectedCount >= cutoff.neededInBucket) break;
	}
	return selected;
}

function shouldPaintBucket(bucket: number, cutoff: Cutoff, cutoffKeys: Set<number> | null, x: number, y: number, dims: ToneDimensions): boolean {
	if (bucket < cutoff.bucket) return true;
	if (bucket > cutoff.bucket) return false;
	if (cutoff.neededInBucket <= 0) return false;
	if (cutoff.neededInBucket >= cutoff.bucketCount) return true;
	return cutoffKeys?.has(canonicalPixelKey(x, y, dims)) ?? false;
}

function setBlackAlpha(out: Uint8ClampedArray, pixelIndex: number, alpha: number): void {
	const offset = pixelIndex * 4;
	out[offset] = 0;
	out[offset + 1] = 0;
	out[offset + 2] = 0;
	out[offset + 3] = alpha;
}

/**
 * Generate a tileable black-on-transparent screentone as RGBA bytes.
 *
 * The geometric score field is periodic across the full output bounds and edge
 * hashes collapse the last row/column onto the first. That makes the produced
 * buffer safe to repeat as a texture without a visible seam.
 */
export function generateTone(width: number, height: number, options: ToneOptions): Uint8ClampedArray {
	const dims = normalizeDimensions(width, height);
	const toneOptions = normalizeToneOptions(options);
	const out = new Uint8ClampedArray(dims.total * 4);
	if (dims.total === 0 || toneOptions.density <= 0) return out;
	if (toneOptions.density >= 1) {
		for (let i = 0; i < dims.total; i++) setBlackAlpha(out, i, 255);
		return out;
	}

	const histogram = buildScoreHistogram(dims, toneOptions);
	const cutoff = cutoffForDensity(histogram, dims.total, toneOptions.density);
	const cutoffKeys =
		cutoff.neededInBucket > 0 && cutoff.neededInBucket < cutoff.bucketCount
			? selectCutoffKeys(dims, toneOptions, cutoff)
			: null;
	for (let y = 0; y < dims.height; y++) {
		for (let x = 0; x < dims.width; x++) {
			const bucket = toneScoreBucket(x, y, dims, toneOptions);
			if (shouldPaintBucket(bucket, cutoff, cutoffKeys, x, y, dims)) setBlackAlpha(out, y * dims.width + x, 255);
		}
	}
	return out;
}

function coverageByBucket(histogram: Uint32Array, total: number): Float32Array {
	const coverage = new Float32Array(histogram.length);
	let seen = 0;
	for (let bucket = 0; bucket < histogram.length; bucket++) {
		seen += histogram[bucket];
		coverage[bucket] = total > 0 ? seen / total : 0;
	}
	return coverage;
}

function gradientPosition(x: number, y: number, dims: ToneDimensions, axisDeg: number): number {
	const rad = (axisDeg * Math.PI) / 180;
	const ax = Math.cos(rad);
	const ay = Math.sin(rad);
	const u = normalizedCoordinate(x, dims.width);
	const v = normalizedCoordinate(y, dims.height);
	const corners = [0, ax, ay, ax + ay];
	const min = Math.min(...corners);
	const max = Math.max(...corners);
	if (max === min) return 1;
	return clamp01((u * ax + v * ay - min) / (max - min));
}

/**
 * Generate a screentone whose average opacity ramps from light to dark along an axis.
 * The tone pattern keeps the same tile-safe score field as generateTone; only the
 * local score cutoff changes across the gradient.
 */
export function gradientTone(width: number, height: number, options: GradientToneOptions): Uint8ClampedArray {
	const dims = normalizeDimensions(width, height);
	const toneOptions = normalizeToneOptions(options);
	const out = new Uint8ClampedArray(dims.total * 4);
	if (dims.total === 0) return out;

	const fromDensity = clamp01(options.fromDensity ?? 0);
	const toDensity = clamp01(options.toDensity ?? toneOptions.density);
	const axisDeg = Number.isFinite(options.axisDeg) ? (options.axisDeg ?? 0) : 0;
	const histogram = buildScoreHistogram(dims, toneOptions);
	const coverage = coverageByBucket(histogram, dims.total);

	for (let y = 0; y < dims.height; y++) {
		for (let x = 0; x < dims.width; x++) {
			const t = gradientPosition(x, y, dims, axisDeg);
			const localDensity = fromDensity + (toDensity - fromDensity) * t;
			if (localDensity <= 0) continue;
			const bucket = toneScoreBucket(x, y, dims, toneOptions);
			if (localDensity >= 1 || coverage[bucket] <= localDensity) setBlackAlpha(out, y * dims.width + x, 255);
		}
	}
	return out;
}

/**
 * Fill only masked pixels in an ImageData-like RGBA buffer with the requested tone.
 * Partial mask values scale the generated tone alpha so feathered selections remain soft.
 */
export function fillMaskWithTone<T extends ImageDataLike>(imageDataLike: T, mask: Uint8Array, options: ToneOptions): T {
	const dims = normalizeDimensions(imageDataLike.width, imageDataLike.height);
	if (imageDataLike.data.length !== dims.total * 4) {
		throw new Error(`fillMaskWithTone: expected ${dims.total * 4} RGBA bytes, got ${imageDataLike.data.length}`);
	}
	if (mask.length !== dims.total) {
		throw new Error(`fillMaskWithTone: expected ${dims.total} mask bytes, got ${mask.length}`);
	}
	const tone = generateTone(dims.width, dims.height, options);
	const out = imageDataLike.data;
	for (let i = 0; i < dims.total; i++) {
		const maskAlpha = mask[i];
		if (maskAlpha <= 0) continue;
		const toneOffset = i * 4;
		const alpha = Math.round((tone[toneOffset + 3] * maskAlpha) / 255);
		setBlackAlpha(out, i, alpha);
	}
	return imageDataLike;
}
