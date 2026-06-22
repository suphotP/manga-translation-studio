export type ProCleanStrategy = "none" | "flat" | "gradient" | "screentone" | "line";
export type ProCleanBackgroundStrategy = "flat" | "gradient" | "screentone";

export interface ProCleanImageDataLike {
	data: Uint8Array | Uint8ClampedArray;
	width: number;
	height: number;
}

export interface ProCleanOptions {
	strategy?: "auto" | "flat" | "gradient" | "screentone" | "line";
	ringRadius?: number;
	patchSize?: number;
	patchMatchIterations?: number;
	diffusionIterations?: number;
	seed?: number;
	lineWidth?: number;
}

export interface ProCleanBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ProCleanClassification {
	sampleCount: number;
	lumaStd: number;
	edgeEnergy: number;
	gradientStrength: number;
	planeResidualStd: number;
	darkRatio: number;
	lineDetected: boolean;
	lineConfidence: number;
}

export interface ProCleanResult {
	imageData: {
		data: Uint8ClampedArray;
		width: number;
		height: number;
	};
	strategy: ProCleanStrategy;
	backgroundStrategy: ProCleanBackgroundStrategy | null;
	bounds: ProCleanBounds | null;
	classification: ProCleanClassification;
	limitations: string[];
}

interface InternalOptions {
	strategy: "auto" | "flat" | "gradient" | "screentone" | "line";
	ringRadius: number;
	patchSize: number;
	patchRadius: number;
	patchMatchIterations: number;
	diffusionIterations: number;
	seed: number;
	lineWidth: number | null;
}

interface InternalBounds {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	width: number;
	height: number;
}

interface Plane {
	a: number;
	b: number;
	c: number;
}

interface BackgroundStats {
	sampleCount: number;
	medianRgb: [number, number, number];
	medianLuma: number;
	lumaMean: number;
	lumaStd: number;
	edgeEnergy: number;
	gradientStrength: number;
	planeResidualStd: number;
	darkRatio: number;
	planes: {
		r: Plane | null;
		g: Plane | null;
		b: Plane | null;
		luma: Plane | null;
	};
}

type LineOrientation = "horizontal" | "vertical" | "diag-down" | "diag-up";

interface LineModel {
	orientation: LineOrientation;
	key: number;
	distanceScale: number;
	width: number;
	rgb: [number, number, number];
	darkThreshold: number;
	confidence: number;
}

interface LineBin {
	count: number;
	keySum: number;
	lowSide: number;
	highSide: number;
	minProjection: number;
	maxProjection: number;
	projectionBuckets: Set<number>;
}

const FALLBACK_STATS: BackgroundStats = {
	sampleCount: 0,
	medianRgb: [255, 255, 255],
	medianLuma: 255,
	lumaMean: 255,
	lumaStd: 0,
	edgeEnergy: 0,
	gradientStrength: 0,
	planeResidualStd: 0,
	darkRatio: 0,
	planes: { r: null, g: null, b: null, luma: null },
};

/**
 * Client-side manga clean core. It returns a copied RGBA buffer and a receipt of
 * the strategy that was used, because pro tools must be auditable when a fill is
 * approximate rather than AI-semantic.
 */
export function proClean(
	imageDataLike: ProCleanImageDataLike,
	mask: Uint8Array,
	options: ProCleanOptions = {},
): ProCleanResult {
	const width = assertPositiveInt(imageDataLike.width, "width");
	const height = assertPositiveInt(imageDataLike.height, "height");
	const total = width * height;
	if (imageDataLike.data.length !== total * 4) {
		throw new Error("proClean expected RGBA data length to equal width * height * 4.");
	}
	if (mask.length !== total) {
		throw new Error("proClean expected mask length to equal width * height.");
	}

	const opts = normalizeOptions(options);
	const sourceData = new Uint8ClampedArray(imageDataLike.data);
	const outData = new Uint8ClampedArray(sourceData);
	const bounds = computeMaskBounds(mask, width, height);
	const emptyClassification = classificationFromStats(FALLBACK_STATS, null);
	if (!bounds) {
		return {
			imageData: { data: outData, width, height },
			strategy: "none",
			backgroundStrategy: null,
			bounds: null,
			classification: emptyClassification,
			limitations: [],
		};
	}

	const maskedPixels = collectMaskedPixels(mask, width, bounds);
	const ringIndices = collectRingIndices(mask, width, height, bounds, opts.ringRadius);
	const limitations: string[] = [];
	if (ringIndices.length === 0) {
		limitations.push("No source ring pixels were available; used white median fallback.");
	}

	const baseStats = analyzeRing(sourceData, mask, width, ringIndices, null);
	const shouldTryLine = opts.strategy === "auto" || opts.strategy === "line";
	const lineModel = shouldTryLine
		? detectLineModel(sourceData, width, bounds, ringIndices, baseStats, opts)
		: null;

	let strategy: ProCleanStrategy;
	let backgroundStrategy: ProCleanBackgroundStrategy | null = null;
	let statsForFill = baseStats;
	let lineForFill: LineModel | null = null;

	if (opts.strategy === "line") {
		if (lineModel) {
			strategy = "line";
			lineForFill = lineModel;
			statsForFill = analyzeRing(sourceData, mask, width, ringIndices, lineModel);
			backgroundStrategy = chooseBackgroundStrategy(statsForFill);
		} else {
			strategy = "screentone";
			backgroundStrategy = "screentone";
			limitations.push("Line continuation needed two aligned boundary anchors; fell back to screentone PatchMatch.");
		}
	} else if (opts.strategy && opts.strategy !== "auto") {
		strategy = opts.strategy;
		backgroundStrategy = opts.strategy;
	} else if (lineModel) {
		strategy = "line";
		lineForFill = lineModel;
		statsForFill = analyzeRing(sourceData, mask, width, ringIndices, lineModel);
		backgroundStrategy = chooseBackgroundStrategy(statsForFill);
	} else {
		backgroundStrategy = chooseBackgroundStrategy(baseStats);
		strategy = backgroundStrategy;
	}

	if (strategy === "line") {
		const fill = backgroundStrategy ?? "screentone";
		applyBackgroundStrategy(fill, sourceData, outData, mask, width, height, maskedPixels, bounds, statsForFill, opts, limitations, lineForFill);
		if (lineForFill) applyLineContinuation(outData, width, maskedPixels, lineForFill);
	} else if (strategy === "flat" || strategy === "gradient" || strategy === "screentone") {
		applyBackgroundStrategy(strategy, sourceData, outData, mask, width, height, maskedPixels, bounds, statsForFill, opts, limitations, null);
	}

	return {
		imageData: { data: outData, width, height },
		strategy,
		backgroundStrategy,
		bounds: boundsToPublic(bounds),
		classification: classificationFromStats(statsForFill, lineForFill),
		limitations,
	};
}

function applyBackgroundStrategy(
	strategy: ProCleanBackgroundStrategy,
	sourceData: Uint8ClampedArray,
	outData: Uint8ClampedArray,
	mask: Uint8Array,
	width: number,
	height: number,
	maskedPixels: number[],
	bounds: InternalBounds,
	stats: BackgroundStats,
	opts: InternalOptions,
	limitations: string[],
	excludeLine: LineModel | null,
): void {
	if (strategy === "flat") {
		applyFlatFill(outData, maskedPixels, stats.medianRgb);
		return;
	}
	if (strategy === "gradient") {
		applyGradientDiffusion(sourceData, outData, mask, width, height, maskedPixels, stats, opts);
		return;
	}
	applyPatchMatchFill(sourceData, outData, mask, width, height, maskedPixels, bounds, stats, opts, limitations, excludeLine);
}

function applyFlatFill(
	outData: Uint8ClampedArray,
	maskedPixels: number[],
	rgb: [number, number, number],
): void {
	for (const idx of maskedPixels) {
		const o = idx * 4;
		outData[o] = rgb[0];
		outData[o + 1] = rgb[1];
		outData[o + 2] = rgb[2];
		// Alpha is left untouched so cleanup never changes page transparency.
	}
}

function applyGradientDiffusion(
	sourceData: Uint8ClampedArray,
	outData: Uint8ClampedArray,
	mask: Uint8Array,
	width: number,
	height: number,
	maskedPixels: number[],
	stats: BackgroundStats,
	opts: InternalOptions,
): void {
	const count = maskedPixels.length;
	if (count === 0) return;
	const maskPos = new Int32Array(width * height);
	maskPos.fill(-1);
	for (let i = 0; i < count; i++) maskPos[maskedPixels[i]] = i;

	let prev = new Float32Array(count * 3);
	let next = new Float32Array(count * 3);
	for (let i = 0; i < count; i++) {
		const idx = maskedPixels[i];
		const x = idx % width;
		const y = (idx - x) / width;
		const o = i * 3;
		prev[o] = clampByteFloat(evaluatePlane(stats.planes.r, x, y, stats.medianRgb[0]));
		prev[o + 1] = clampByteFloat(evaluatePlane(stats.planes.g, x, y, stats.medianRgb[1]));
		prev[o + 2] = clampByteFloat(evaluatePlane(stats.planes.b, x, y, stats.medianRgb[2]));
	}

	const iterations = opts.diffusionIterations;
	for (let iter = 0; iter < iterations; iter++) {
		for (let i = 0; i < count; i++) {
			const idx = maskedPixels[i];
			const x = idx % width;
			const y = (idx - x) / width;
			let r = 0;
			let g = 0;
			let b = 0;
			let n = 0;

			if (x > 0) {
				const ni = idx - 1;
				const pos = maskPos[ni];
				if (mask[ni] > 0 && pos >= 0) {
					const o = pos * 3;
					r += prev[o];
					g += prev[o + 1];
					b += prev[o + 2];
				} else {
					const o = ni * 4;
					r += sourceData[o];
					g += sourceData[o + 1];
					b += sourceData[o + 2];
				}
				n++;
			}
			if (x + 1 < width) {
				const ni = idx + 1;
				const pos = maskPos[ni];
				if (mask[ni] > 0 && pos >= 0) {
					const o = pos * 3;
					r += prev[o];
					g += prev[o + 1];
					b += prev[o + 2];
				} else {
					const o = ni * 4;
					r += sourceData[o];
					g += sourceData[o + 1];
					b += sourceData[o + 2];
				}
				n++;
			}
			if (y > 0) {
				const ni = idx - width;
				const pos = maskPos[ni];
				if (mask[ni] > 0 && pos >= 0) {
					const o = pos * 3;
					r += prev[o];
					g += prev[o + 1];
					b += prev[o + 2];
				} else {
					const o = ni * 4;
					r += sourceData[o];
					g += sourceData[o + 1];
					b += sourceData[o + 2];
				}
				n++;
			}
			if (y + 1 < height) {
				const ni = idx + width;
				const pos = maskPos[ni];
				if (mask[ni] > 0 && pos >= 0) {
					const o = pos * 3;
					r += prev[o];
					g += prev[o + 1];
					b += prev[o + 2];
				} else {
					const o = ni * 4;
					r += sourceData[o];
					g += sourceData[o + 1];
					b += sourceData[o + 2];
				}
				n++;
			}

			const o = i * 3;
			if (n === 0) {
				next[o] = prev[o];
				next[o + 1] = prev[o + 1];
				next[o + 2] = prev[o + 2];
			} else {
				next[o] = r / n;
				next[o + 1] = g / n;
				next[o + 2] = b / n;
			}
		}
		const swap = prev;
		prev = next;
		next = swap;
	}

	for (let i = 0; i < count; i++) {
		const idx = maskedPixels[i];
		const dst = idx * 4;
		const src = i * 3;
		outData[dst] = clampByte(prev[src]);
		outData[dst + 1] = clampByte(prev[src + 1]);
		outData[dst + 2] = clampByte(prev[src + 2]);
	}
}

function applyPatchMatchFill(
	sourceData: Uint8ClampedArray,
	outData: Uint8ClampedArray,
	mask: Uint8Array,
	width: number,
	height: number,
	maskedPixels: number[],
	bounds: InternalBounds,
	stats: BackgroundStats,
	opts: InternalOptions,
	limitations: string[],
	excludeLine: LineModel | null,
): void {
	const sourceCandidates = collectPatchSourceCandidates(sourceData, mask, width, height, bounds, opts, excludeLine);
	if (sourceCandidates.length === 0) {
		limitations.push("No clean source patches were available for PatchMatch; used median fill.");
		applyFlatFill(outData, maskedPixels, stats.medianRgb);
		return;
	}
	const sourceEligible = new Uint8Array(width * height);
	for (const idx of sourceCandidates) sourceEligible[idx] = 1;

	const random = makeRandom(opts.seed);
	const count = maskedPixels.length;
	const maskPos = new Int32Array(width * height);
	maskPos.fill(-1);
	for (let i = 0; i < count; i++) maskPos[maskedPixels[i]] = i;

	const sourceX = new Int32Array(count);
	const sourceY = new Int32Array(count);
	const bestScore = new Float64Array(count);
	for (let i = 0; i < count; i++) {
		const sourceIdx = sourceCandidates[Math.floor(random() * sourceCandidates.length)];
		sourceX[i] = sourceIdx % width;
		sourceY[i] = (sourceIdx - sourceX[i]) / width;
		bestScore[i] = patchDistance(sourceData, outData, mask, width, height, maskedPixels[i], sourceX[i], sourceY[i], opts.patchRadius, Infinity);
		copySourcePixel(sourceData, outData, maskedPixels[i], sourceIdx);
	}

	for (let iter = 0; iter < opts.patchMatchIterations; iter++) {
		const forward = iter % 2 === 0;
		const start = forward ? 0 : count - 1;
		const end = forward ? count : -1;
		const step = forward ? 1 : -1;
		for (let i = start; i !== end; i += step) {
			const idx = maskedPixels[i];
			const x = idx % width;
			const y = (idx - x) / width;
			if (forward) {
				if (x > 0) tryNeighborCandidate(i, maskPos[idx - 1], 1, 0, sourceData, outData, mask, sourceEligible, width, height, maskedPixels, sourceX, sourceY, bestScore, opts);
				if (y > 0) tryNeighborCandidate(i, maskPos[idx - width], 0, 1, sourceData, outData, mask, sourceEligible, width, height, maskedPixels, sourceX, sourceY, bestScore, opts);
			} else {
				if (x + 1 < width) tryNeighborCandidate(i, maskPos[idx + 1], -1, 0, sourceData, outData, mask, sourceEligible, width, height, maskedPixels, sourceX, sourceY, bestScore, opts);
				if (y + 1 < height) tryNeighborCandidate(i, maskPos[idx + width], 0, -1, sourceData, outData, mask, sourceEligible, width, height, maskedPixels, sourceX, sourceY, bestScore, opts);
			}
			randomSearchCandidate(i, sourceCandidates, sourceEligible, sourceData, outData, mask, width, height, maskedPixels, sourceX, sourceY, bestScore, opts, random);
		}
	}
}

function tryNeighborCandidate(
	targetPos: number,
	neighborPos: number,
	dx: number,
	dy: number,
	sourceData: Uint8ClampedArray,
	outData: Uint8ClampedArray,
	mask: Uint8Array,
	sourceEligible: Uint8Array,
	width: number,
	height: number,
	maskedPixels: number[],
	sourceX: Int32Array,
	sourceY: Int32Array,
	bestScore: Float64Array,
	opts: InternalOptions,
): void {
	if (neighborPos < 0) return;
	const sx = sourceX[neighborPos] + dx;
	const sy = sourceY[neighborPos] + dy;
	if (sx < 0 || sy < 0 || sx >= width || sy >= height || sourceEligible[sy * width + sx] === 0) return;
	tryPatchCandidate(targetPos, sx, sy, sourceData, outData, mask, width, height, maskedPixels, sourceX, sourceY, bestScore, opts);
}

function randomSearchCandidate(
	targetPos: number,
	sourceCandidates: number[],
	sourceEligible: Uint8Array,
	sourceData: Uint8ClampedArray,
	outData: Uint8ClampedArray,
	mask: Uint8Array,
	width: number,
	height: number,
	maskedPixels: number[],
	sourceX: Int32Array,
	sourceY: Int32Array,
	bestScore: Float64Array,
	opts: InternalOptions,
	random: () => number,
): void {
	let radius = Math.max(4, opts.ringRadius);
	while (radius >= 1) {
		const sx = Math.round(sourceX[targetPos] + (random() * 2 - 1) * radius);
		const sy = Math.round(sourceY[targetPos] + (random() * 2 - 1) * radius);
		if (sx >= 0 && sy >= 0 && sx < width && sy < height && sourceEligible[sy * width + sx] > 0) {
			tryPatchCandidate(targetPos, sx, sy, sourceData, outData, mask, width, height, maskedPixels, sourceX, sourceY, bestScore, opts);
		}
		const randomIdx = sourceCandidates[Math.floor(random() * sourceCandidates.length)];
		const rx = randomIdx % width;
		const ry = (randomIdx - rx) / width;
		tryPatchCandidate(targetPos, rx, ry, sourceData, outData, mask, width, height, maskedPixels, sourceX, sourceY, bestScore, opts);
		radius = Math.floor(radius / 2);
	}
}

function tryPatchCandidate(
	targetPos: number,
	sx: number,
	sy: number,
	sourceData: Uint8ClampedArray,
	outData: Uint8ClampedArray,
	mask: Uint8Array,
	width: number,
	height: number,
	maskedPixels: number[],
	sourceX: Int32Array,
	sourceY: Int32Array,
	bestScore: Float64Array,
	opts: InternalOptions,
): void {
	const idx = maskedPixels[targetPos];
	const score = patchDistance(sourceData, outData, mask, width, height, idx, sx, sy, opts.patchRadius, bestScore[targetPos]);
	if (score >= bestScore[targetPos]) return;
	sourceX[targetPos] = sx;
	sourceY[targetPos] = sy;
	bestScore[targetPos] = score;
	copySourcePixel(sourceData, outData, idx, sy * width + sx);
}

function patchDistance(
	sourceData: Uint8ClampedArray,
	outData: Uint8ClampedArray,
	mask: Uint8Array,
	width: number,
	height: number,
	targetIdx: number,
	sourceX: number,
	sourceY: number,
	patchRadius: number,
	currentBest: number,
): number {
	const targetX = targetIdx % width;
	const targetY = (targetIdx - targetX) / width;
	let score = 0;
	let samples = 0;
	const earlyLimit = Number.isFinite(currentBest) ? currentBest * 49 : Infinity;
	for (let dy = -patchRadius; dy <= patchRadius; dy++) {
		const ty = targetY + dy;
		const sy = sourceY + dy;
		if (ty < 0 || ty >= height || sy < 0 || sy >= height) continue;
		for (let dx = -patchRadius; dx <= patchRadius; dx++) {
			const tx = targetX + dx;
			const sx = sourceX + dx;
			if (tx < 0 || tx >= width || sx < 0 || sx >= width) continue;
			const targetPatchIdx = ty * width + tx;
			const targetOffset = targetPatchIdx * 4;
			const sourceOffset = (sy * width + sx) * 4;
			const target = mask[targetPatchIdx] > 0 ? outData : sourceData;
			const dr = target[targetOffset] - sourceData[sourceOffset];
			const dg = target[targetOffset + 1] - sourceData[sourceOffset + 1];
			const db = target[targetOffset + 2] - sourceData[sourceOffset + 2];
			score += dr * dr + dg * dg + db * db;
			samples++;
			if (score > earlyLimit) return score / Math.max(1, samples);
		}
	}
	return score / Math.max(1, samples);
}

function copySourcePixel(
	sourceData: Uint8ClampedArray,
	outData: Uint8ClampedArray,
	targetIdx: number,
	sourceIdx: number,
): void {
	const targetOffset = targetIdx * 4;
	const sourceOffset = sourceIdx * 4;
	outData[targetOffset] = sourceData[sourceOffset];
	outData[targetOffset + 1] = sourceData[sourceOffset + 1];
	outData[targetOffset + 2] = sourceData[sourceOffset + 2];
}

function applyLineContinuation(
	outData: Uint8ClampedArray,
	width: number,
	maskedPixels: number[],
	line: LineModel,
): void {
	for (const idx of maskedPixels) {
		const x = idx % width;
		const y = (idx - x) / width;
		if (!isOnLine(line, x, y, 0.35)) continue;
		const o = idx * 4;
		outData[o] = line.rgb[0];
		outData[o + 1] = line.rgb[1];
		outData[o + 2] = line.rgb[2];
	}
}

function collectPatchSourceCandidates(
	sourceData: Uint8ClampedArray,
	mask: Uint8Array,
	width: number,
	height: number,
	bounds: InternalBounds,
	opts: InternalOptions,
	excludeLine: LineModel | null,
): number[] {
	const x0 = Math.max(0, bounds.x0 - opts.ringRadius);
	const y0 = Math.max(0, bounds.y0 - opts.ringRadius);
	const x1 = Math.min(width - 1, bounds.x1 + opts.ringRadius);
	const y1 = Math.min(height - 1, bounds.y1 + opts.ringRadius);
	const out: number[] = [];
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			const idx = y * width + x;
			if (mask[idx] > 0) continue;
			if (!isPatchSourceValid(mask, width, height, x, y, opts.patchRadius, excludeLine)) continue;
			if (excludeLine && lumaAt(sourceData, idx * 4) <= excludeLine.darkThreshold && isOnLine(excludeLine, x, y, 1)) continue;
			out.push(idx);
		}
	}
	return out;
}

function isPatchSourceValid(
	mask: Uint8Array,
	width: number,
	height: number,
	x: number,
	y: number,
	radius: number,
	excludeLine: LineModel | null,
): boolean {
	if (x - radius < 0 || y - radius < 0 || x + radius >= width || y + radius >= height) return false;
	for (let yy = y - radius; yy <= y + radius; yy++) {
		for (let xx = x - radius; xx <= x + radius; xx++) {
			const idx = yy * width + xx;
			if (mask[idx] > 0) return false;
			if (excludeLine && isOnLine(excludeLine, xx, yy, 0.6)) return false;
		}
	}
	return true;
}

function detectLineModel(
	data: Uint8ClampedArray,
	width: number,
	bounds: InternalBounds,
	ringIndices: number[],
	stats: BackgroundStats,
	opts: InternalOptions,
): LineModel | null {
	if (ringIndices.length < 8) return null;
	const darkThreshold = Math.max(20, Math.min(150, stats.medianLuma - 55));
	const darkPoints: number[] = [];
	for (const idx of ringIndices) {
		if (lumaAt(data, idx * 4) <= darkThreshold) darkPoints.push(idx);
	}
	if (darkPoints.length < 6) return null;
	// Dense dark samples are usually screentone/hatching, not a single border.
	// Auto-continuing a false line is more damaging than falling back to texture.
	if (darkPoints.length / ringIndices.length > 0.18 && stats.edgeEnergy > 15) return null;

	let best: { orientation: LineOrientation; key: number; score: number; bin: LineBin; scale: number } | null = null;
	const orientations: LineOrientation[] = ["horizontal", "vertical", "diag-down", "diag-up"];
	for (const orientation of orientations) {
		const bins = new Map<number, LineBin>();
		const centerProjection = projectionFor(orientation, (bounds.x0 + bounds.x1) / 2, (bounds.y0 + bounds.y1) / 2);
		const sideGap = Math.max(3, Math.min(bounds.width, bounds.height) * 0.35);
		for (const idx of darkPoints) {
			const x = idx % width;
			const y = (idx - x) / width;
			const key = Math.round(keyFor(orientation, x, y));
			const projection = projectionFor(orientation, x, y);
			let bin = bins.get(key);
			if (!bin) {
				bin = {
					count: 0,
					keySum: 0,
					lowSide: 0,
					highSide: 0,
					minProjection: Infinity,
					maxProjection: -Infinity,
					projectionBuckets: new Set<number>(),
				};
				bins.set(key, bin);
			}
			addPointToBin(bin, key, projection, centerProjection, sideGap);
		}

		for (const [key] of bins) {
			const combined = combineBins(bins, key);
			if (!lineKeyIntersectsBounds(orientation, combined.keySum / combined.count, bounds)) continue;
			const projectionSpan = combined.maxProjection - combined.minProjection;
			const coverage = combined.projectionBuckets.size;
			const minCoverage = Math.max(4, Math.floor(Math.min(bounds.width, bounds.height) / 5));
			if (combined.lowSide < 2 || combined.highSide < 2) continue;
			if (coverage < minCoverage) continue;
			if (projectionSpan < Math.min(bounds.width, bounds.height) * 0.8) continue;
			const score = combined.count * 2 + coverage * 3 + projectionSpan * 0.15;
			if (!best || score > best.score) {
				best = {
					orientation,
					key: combined.keySum / combined.count,
					score,
					bin: combined,
					scale: orientation === "horizontal" || orientation === "vertical" ? 1 : Math.SQRT2,
				};
			}
		}
	}

	if (!best) return null;
	const minScore = Math.max(20, Math.min(bounds.width, bounds.height) * 0.6);
	if (best.score < minScore) return null;
	const widthEstimate = opts.lineWidth ?? estimateLineWidth(best.orientation, best.key, darkPoints, width, best.scale);
	const line: LineModel = {
		orientation: best.orientation,
		key: best.key,
		distanceScale: best.scale,
		width: Math.max(0.75, Math.min(4, widthEstimate)),
		rgb: medianRgbForLine(data, width, darkPoints, best.orientation, best.key, darkThreshold),
		darkThreshold,
		confidence: Math.min(1, best.score / (minScore * 3)),
	};
	return line;
}

function addPointToBin(
	bin: LineBin,
	key: number,
	projection: number,
	centerProjection: number,
	sideGap: number,
): void {
	bin.count++;
	bin.keySum += key;
	if (projection < centerProjection - sideGap) bin.lowSide++;
	if (projection > centerProjection + sideGap) bin.highSide++;
	if (projection < bin.minProjection) bin.minProjection = projection;
	if (projection > bin.maxProjection) bin.maxProjection = projection;
	bin.projectionBuckets.add(Math.round(projection / 2));
}

function combineBins(bins: Map<number, LineBin>, key: number): LineBin {
	const out: LineBin = {
		count: 0,
		keySum: 0,
		lowSide: 0,
		highSide: 0,
		minProjection: Infinity,
		maxProjection: -Infinity,
		projectionBuckets: new Set<number>(),
	};
	for (let k = key - 1; k <= key + 1; k++) {
		const bin = bins.get(k);
		if (!bin) continue;
		out.count += bin.count;
		out.keySum += bin.keySum;
		out.lowSide += bin.lowSide;
		out.highSide += bin.highSide;
		out.minProjection = Math.min(out.minProjection, bin.minProjection);
		out.maxProjection = Math.max(out.maxProjection, bin.maxProjection);
		for (const bucket of bin.projectionBuckets) out.projectionBuckets.add(bucket);
	}
	return out;
}

function estimateLineWidth(
	orientation: LineOrientation,
	key: number,
	darkPoints: number[],
	width: number,
	scale: number,
): number {
	let maxDistance = 0.75;
	for (const idx of darkPoints) {
		const x = idx % width;
		const y = (idx - x) / width;
		const d = Math.abs(keyFor(orientation, x, y) - key) / scale;
		if (d <= 4 && d > maxDistance) maxDistance = d;
	}
	return maxDistance + 0.35;
}

function medianRgbForLine(
	data: Uint8ClampedArray,
	width: number,
	darkPoints: number[],
	orientation: LineOrientation,
	key: number,
	darkThreshold: number,
): [number, number, number] {
	const r = new Int32Array(256);
	const g = new Int32Array(256);
	const b = new Int32Array(256);
	let count = 0;
	for (const idx of darkPoints) {
		const x = idx % width;
		const y = (idx - x) / width;
		if (Math.abs(keyFor(orientation, x, y) - key) > 2) continue;
		const o = idx * 4;
		if (lumaAt(data, o) > darkThreshold) continue;
		r[data[o]]++;
		g[data[o + 1]]++;
		b[data[o + 2]]++;
		count++;
	}
	if (count === 0) return [24, 24, 24];
	return [histMedian(r, count), histMedian(g, count), histMedian(b, count)];
}

function analyzeRing(
	data: Uint8ClampedArray,
	mask: Uint8Array,
	width: number,
	ringIndices: number[],
	excludeLine: LineModel | null,
): BackgroundStats {
	const histR = new Int32Array(256);
	const histG = new Int32Array(256);
	const histB = new Int32Array(256);
	const histL = new Int32Array(256);
	const accepted: number[] = [];
	let sum = 0;
	let sumSq = 0;
	let leftSum = 0;
	let leftN = 0;
	let rightSum = 0;
	let rightN = 0;
	let topSum = 0;
	let topN = 0;
	let bottomSum = 0;
	let bottomN = 0;
	const center = centroidFromIndices(ringIndices, width);
	for (const idx of ringIndices) {
		const x = idx % width;
		const y = (idx - x) / width;
		if (excludeLine && lumaAt(data, idx * 4) <= excludeLine.darkThreshold && isOnLine(excludeLine, x, y, 1)) continue;
		const o = idx * 4;
		const r = data[o];
		const g = data[o + 1];
		const b = data[o + 2];
		const luma = Math.round(lumaAt(data, o));
		histR[r]++;
		histG[g]++;
		histB[b]++;
		histL[luma]++;
		accepted.push(idx);
		sum += luma;
		sumSq += luma * luma;
		if (x < center.x) {
			leftSum += luma;
			leftN++;
		} else {
			rightSum += luma;
			rightN++;
		}
		if (y < center.y) {
			topSum += luma;
			topN++;
		} else {
			bottomSum += luma;
			bottomN++;
		}
	}

	const sampleCount = accepted.length;
	if (sampleCount === 0) return FALLBACK_STATS;
	const mean = sum / sampleCount;
	const variance = Math.max(0, sumSq / sampleCount - mean * mean);
	const medianRgb: [number, number, number] = [
		histMedian(histR, sampleCount),
		histMedian(histG, sampleCount),
		histMedian(histB, sampleCount),
	];
	const medianLuma = histMedian(histL, sampleCount);
	const edgeEnergy = computeEdgeEnergy(data, mask, width, accepted, excludeLine);
	const horizontal = leftN > 0 && rightN > 0 ? Math.abs(leftSum / leftN - rightSum / rightN) : 0;
	const vertical = topN > 0 && bottomN > 0 ? Math.abs(topSum / topN - bottomSum / bottomN) : 0;
	const lumaPlane = fitPlane(data, width, accepted, "luma");
	const planeResidualStd = lumaPlane ? planeResidual(data, width, accepted, lumaPlane, "luma") : Infinity;
	let dark = 0;
	const darkThreshold = Math.max(20, Math.min(150, medianLuma - 55));
	for (const idx of accepted) {
		if (lumaAt(data, idx * 4) <= darkThreshold) dark++;
	}
	return {
		sampleCount,
		medianRgb,
		medianLuma,
		lumaMean: mean,
		lumaStd: Math.sqrt(variance),
		edgeEnergy,
		gradientStrength: Math.max(horizontal, vertical),
		planeResidualStd,
		darkRatio: dark / sampleCount,
		planes: {
			r: fitPlane(data, width, accepted, "r"),
			g: fitPlane(data, width, accepted, "g"),
			b: fitPlane(data, width, accepted, "b"),
			luma: lumaPlane,
		},
	};
}

function chooseBackgroundStrategy(stats: BackgroundStats): ProCleanBackgroundStrategy {
	if (stats.sampleCount < 4) return "flat";
	if (stats.lumaStd <= 4.5 && stats.edgeEnergy <= 6) return "flat";
	const planeGood =
		stats.gradientStrength >= 8 &&
		stats.edgeEnergy <= Math.max(8, stats.gradientStrength * 0.6) &&
		stats.planeResidualStd <= Math.max(6, stats.lumaStd * 0.45);
	if (planeGood) return "gradient";
	return "screentone";
}

function computeEdgeEnergy(
	data: Uint8ClampedArray,
	mask: Uint8Array,
	width: number,
	indices: number[],
	excludeLine: LineModel | null,
): number {
	let sum = 0;
	let count = 0;
	for (const idx of indices) {
		const x = idx % width;
		const y = (idx - x) / width;
		const base = lumaAt(data, idx * 4);
		if (x + 1 < width) {
			const ni = idx + 1;
			if (mask[ni] === 0 && !excludedByLine(data, width, ni, excludeLine)) {
				sum += Math.abs(base - lumaAt(data, ni * 4));
				count++;
			}
		}
		if (idx + width < mask.length) {
			const ni = idx + width;
			if (mask[ni] === 0 && !excludedByLine(data, width, ni, excludeLine)) {
				sum += Math.abs(base - lumaAt(data, ni * 4));
				count++;
			}
		}
	}
	return count === 0 ? 0 : sum / count;
}

function excludedByLine(
	data: Uint8ClampedArray,
	width: number,
	idx: number,
	line: LineModel | null,
): boolean {
	if (!line) return false;
	const x = idx % width;
	const y = (idx - x) / width;
	return lumaAt(data, idx * 4) <= line.darkThreshold && isOnLine(line, x, y, 1);
}

function fitPlane(
	data: Uint8ClampedArray,
	width: number,
	indices: number[],
	channel: "r" | "g" | "b" | "luma",
): Plane | null {
	if (indices.length < 3) return null;
	let sx = 0;
	let sy = 0;
	let sxx = 0;
	let sxy = 0;
	let syy = 0;
	let sz = 0;
	let sxz = 0;
	let syz = 0;
	for (const idx of indices) {
		const x = idx % width;
		const y = (idx - x) / width;
		const z = channelValue(data, idx, channel);
		sx += x;
		sy += y;
		sxx += x * x;
		sxy += x * y;
		syy += y * y;
		sz += z;
		sxz += x * z;
		syz += y * z;
	}
	const solution = solve3x3(sxx, sxy, sx, sxy, syy, sy, sx, sy, indices.length, sxz, syz, sz);
	if (!solution) return null;
	return { a: solution[0], b: solution[1], c: solution[2] };
}

function planeResidual(
	data: Uint8ClampedArray,
	width: number,
	indices: number[],
	plane: Plane,
	channel: "r" | "g" | "b" | "luma",
): number {
	let sumSq = 0;
	for (const idx of indices) {
		const x = idx % width;
		const y = (idx - x) / width;
		const residual = channelValue(data, idx, channel) - evaluatePlane(plane, x, y, 0);
		sumSq += residual * residual;
	}
	return Math.sqrt(sumSq / Math.max(1, indices.length));
}

function solve3x3(
	a00: number,
	a01: number,
	a02: number,
	a10: number,
	a11: number,
	a12: number,
	a20: number,
	a21: number,
	a22: number,
	b0: number,
	b1: number,
	b2: number,
): [number, number, number] | null {
	const det =
		a00 * (a11 * a22 - a12 * a21) -
		a01 * (a10 * a22 - a12 * a20) +
		a02 * (a10 * a21 - a11 * a20);
	if (Math.abs(det) < 1e-8) return null;
	const dx =
		b0 * (a11 * a22 - a12 * a21) -
		a01 * (b1 * a22 - a12 * b2) +
		a02 * (b1 * a21 - a11 * b2);
	const dy =
		a00 * (b1 * a22 - a12 * b2) -
		b0 * (a10 * a22 - a12 * a20) +
		a02 * (a10 * b2 - b1 * a20);
	const dz =
		a00 * (a11 * b2 - b1 * a21) -
		a01 * (a10 * b2 - b1 * a20) +
		b0 * (a10 * a21 - a11 * a20);
	return [dx / det, dy / det, dz / det];
}

function computeMaskBounds(mask: Uint8Array, width: number, height: number): InternalBounds | null {
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			if (mask[row + x] === 0) continue;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}
	if (maxX < 0) return null;
	return { x0: minX, y0: minY, x1: maxX, y1: maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function collectMaskedPixels(mask: Uint8Array, width: number, bounds: InternalBounds): number[] {
	const out: number[] = [];
	for (let y = bounds.y0; y <= bounds.y1; y++) {
		const row = y * width;
		for (let x = bounds.x0; x <= bounds.x1; x++) {
			const idx = row + x;
			if (mask[idx] > 0) out.push(idx);
		}
	}
	return out;
}

function collectRingIndices(
	mask: Uint8Array,
	width: number,
	height: number,
	bounds: InternalBounds,
	ringRadius: number,
): number[] {
	const x0 = Math.max(0, bounds.x0 - ringRadius);
	const y0 = Math.max(0, bounds.y0 - ringRadius);
	const x1 = Math.min(width - 1, bounds.x1 + ringRadius);
	const y1 = Math.min(height - 1, bounds.y1 + ringRadius);
	const out: number[] = [];
	for (let y = y0; y <= y1; y++) {
		const row = y * width;
		for (let x = x0; x <= x1; x++) {
			const idx = row + x;
			if (mask[idx] === 0) out.push(idx);
		}
	}
	return out;
}

function normalizeOptions(options: ProCleanOptions): InternalOptions {
	const patchSize = clampOddInt(options.patchSize ?? 7, 3, 11);
	const ringRadius = assertOptionInt(options.ringRadius ?? Math.max(12, patchSize * 2), 2, 64);
	return {
		strategy: options.strategy ?? "auto",
		ringRadius,
		patchSize,
		patchRadius: Math.floor(patchSize / 2),
		patchMatchIterations: assertOptionInt(options.patchMatchIterations ?? 3, 1, 5),
		diffusionIterations: assertOptionInt(options.diffusionIterations ?? 36, 1, 120),
		seed: Math.trunc(options.seed ?? 0x5eed1234),
		lineWidth: Number.isFinite(options.lineWidth) ? Math.max(0.5, Math.min(6, options.lineWidth as number)) : null,
	};
}

function classificationFromStats(stats: BackgroundStats, line: LineModel | null): ProCleanClassification {
	return {
		sampleCount: stats.sampleCount,
		lumaStd: roundMetric(stats.lumaStd),
		edgeEnergy: roundMetric(stats.edgeEnergy),
		gradientStrength: roundMetric(stats.gradientStrength),
		planeResidualStd: roundMetric(stats.planeResidualStd),
		darkRatio: roundMetric(stats.darkRatio),
		lineDetected: Boolean(line),
		lineConfidence: roundMetric(line?.confidence ?? 0),
	};
}

function boundsToPublic(bounds: InternalBounds): ProCleanBounds {
	return { x: bounds.x0, y: bounds.y0, width: bounds.width, height: bounds.height };
}

function centroidFromIndices(indices: number[], width: number): { x: number; y: number } {
	if (indices.length === 0) return { x: 0, y: 0 };
	let sx = 0;
	let sy = 0;
	for (const idx of indices) {
		const x = idx % width;
		sx += x;
		sy += (idx - x) / width;
	}
	return { x: sx / indices.length, y: sy / indices.length };
}

function lumaAt(data: Uint8ClampedArray, offset: number): number {
	return 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
}

function channelValue(
	data: Uint8ClampedArray,
	idx: number,
	channel: "r" | "g" | "b" | "luma",
): number {
	const o = idx * 4;
	if (channel === "r") return data[o];
	if (channel === "g") return data[o + 1];
	if (channel === "b") return data[o + 2];
	return lumaAt(data, o);
}

function keyFor(orientation: LineOrientation, x: number, y: number): number {
	if (orientation === "horizontal") return y;
	if (orientation === "vertical") return x;
	if (orientation === "diag-down") return y - x;
	return y + x;
}

function projectionFor(orientation: LineOrientation, x: number, y: number): number {
	if (orientation === "horizontal") return x;
	if (orientation === "vertical") return y;
	if (orientation === "diag-down") return (x + y) / Math.SQRT2;
	return (x - y) / Math.SQRT2;
}

function lineKeyIntersectsBounds(
	orientation: LineOrientation,
	key: number,
	bounds: InternalBounds,
): boolean {
	if (orientation === "horizontal") return key >= bounds.y0 - 1 && key <= bounds.y1 + 1;
	if (orientation === "vertical") return key >= bounds.x0 - 1 && key <= bounds.x1 + 1;
	const keys = [
		keyFor(orientation, bounds.x0, bounds.y0),
		keyFor(orientation, bounds.x1, bounds.y0),
		keyFor(orientation, bounds.x0, bounds.y1),
		keyFor(orientation, bounds.x1, bounds.y1),
	];
	return key >= Math.min(...keys) - 1 && key <= Math.max(...keys) + 1;
}

function isOnLine(line: LineModel, x: number, y: number, extraWidth: number): boolean {
	return Math.abs(keyFor(line.orientation, x, y) - line.key) / line.distanceScale <= line.width + extraWidth;
}

function evaluatePlane(plane: Plane | null, x: number, y: number, fallback: number): number {
	if (!plane) return fallback;
	return plane.a * x + plane.b * y + plane.c;
}

function histMedian(hist: Int32Array, count: number): number {
	const target = Math.floor((count - 1) / 2);
	let seen = 0;
	for (let i = 0; i < hist.length; i++) {
		seen += hist[i];
		if (seen > target) return i;
	}
	return 255;
}

function clampByte(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value)));
}

function clampByteFloat(value: number): number {
	return Math.max(0, Math.min(255, value));
}

function clampOddInt(value: number, min: number, max: number): number {
	let out = assertOptionInt(value, min, max);
	if (out % 2 === 0) out++;
	if (out > max) out -= 2;
	return out;
}

function assertOptionInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, Math.round(value)));
}

function assertPositiveInt(value: number, name: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`proClean expected ${name} to be a positive integer.`);
	}
	return value;
}

function roundMetric(value: number): number {
	if (!Number.isFinite(value)) return value;
	return Math.round(value * 1000) / 1000;
}

function makeRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (1664525 * state + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}
