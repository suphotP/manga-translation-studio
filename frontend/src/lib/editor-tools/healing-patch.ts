export interface ImageDataLike {
	width: number;
	height: number;
	data: Uint8Array | Uint8ClampedArray;
}

export interface BoundsRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type HealRegionMethod = "auto" | "smooth" | "texture";

export interface HealRegionOptions {
	method?: HealRegionMethod;
	smoothIterations?: number;
	texturePatchSize?: number;
	texturePasses?: number;
	textureSeed?: number;
	contextRadius?: number;
	varianceThreshold?: number;
	edgeBlendRadius?: number;
}

export interface HealRegionResult {
	applied: BoundsRect | null;
}

interface BoundaryStats {
	count: number;
	mean: [number, number, number, number];
	lumaVariance: number;
}

interface PatchOrigin {
	x: number;
	y: number;
}

const DEFAULT_VARIANCE_THRESHOLD = 900;

/**
 * Heal the non-zero `mask` pixels in-place.
 *
 * This module deliberately works on ImageData-shaped objects instead of DOM
 * canvases so the same core can run in workers, tests, and future server-side
 * preprocessing without pulling editor UI state into the algorithm.
 */
export function healRegion(
	imageData: ImageDataLike,
	mask: Uint8Array,
	options: HealRegionOptions = {},
): HealRegionResult {
	validateImageInput(imageData, mask);

	const bounds = computeMaskBounds(mask, imageData.width, imageData.height);
	if (!bounds) return { applied: null };

	const contextRadius = normalizedContextRadius(options, bounds);
	const boundaryStats = computeBoundaryStats(imageData, mask, bounds, contextRadius);
	if (boundaryStats.count === 0) return { applied: null };

	const method =
		options.method === "smooth" || options.method === "texture"
			? options.method
			: chooseAutoMethod(boundaryStats, options);

	if (method === "texture") {
		const textured = applyTextureFill(imageData, mask, bounds, boundaryStats, contextRadius, options);
		if (textured) return { applied: bounds };
	}

	applySmoothFill(imageData, mask, bounds, boundaryStats.mean, options);
	return { applied: bounds };
}

function validateImageInput(imageData: ImageDataLike, mask: Uint8Array): void {
	const { width, height, data } = imageData;
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		throw new RangeError("healRegion expects positive integer image dimensions.");
	}
	const pixels = width * height;
	if (mask.length !== pixels) {
		throw new RangeError("healRegion mask length must equal width * height.");
	}
	if (data.length !== pixels * 4) {
		throw new RangeError("healRegion image data length must equal width * height * 4.");
	}
}

function computeMaskBounds(mask: Uint8Array, width: number, height: number): BoundsRect | null {
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
	return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function chooseAutoMethod(stats: BoundaryStats, options: HealRegionOptions): "smooth" | "texture" {
	const threshold = options.varianceThreshold ?? DEFAULT_VARIANCE_THRESHOLD;
	return stats.lumaVariance >= threshold ? "texture" : "smooth";
}

function normalizedContextRadius(options: HealRegionOptions, bounds: BoundsRect): number {
	const patchSize = normalizePatchSize(options.texturePatchSize);
	const sizeDriven = Math.max(4, Math.ceil(Math.max(bounds.width, bounds.height) / 2));
	return Math.max(2, Math.round(options.contextRadius ?? Math.max(sizeDriven, patchSize * 2)));
}

function computeBoundaryStats(
	imageData: ImageDataLike,
	mask: Uint8Array,
	bounds: BoundsRect,
	radius: number,
): BoundaryStats {
	const { width, height, data } = imageData;
	const search = expandBounds(bounds, width, height, radius);
	let count = 0;
	let r = 0;
	let g = 0;
	let b = 0;
	let a = 0;
	let luma = 0;
	let lumaSq = 0;
	for (let y = search.y; y < search.y + search.height; y++) {
		const row = y * width;
		for (let x = search.x; x < search.x + search.width; x++) {
			const pixelIndex = row + x;
			if (mask[pixelIndex] !== 0 || !hasMaskedNeighbor(mask, width, height, x, y, radius)) continue;
			const offset = pixelIndex * 4;
			const pr = data[offset];
			const pg = data[offset + 1];
			const pb = data[offset + 2];
			const pa = data[offset + 3];
			const yLuma = toLuma(pr, pg, pb);
			count += 1;
			r += pr;
			g += pg;
			b += pb;
			a += pa;
			luma += yLuma;
			lumaSq += yLuma * yLuma;
		}
	}
	if (count === 0) return { count, mean: [0, 0, 0, 0], lumaVariance: 0 };
	const inv = 1 / count;
	const meanLuma = luma * inv;
	return {
		count,
		mean: [r * inv, g * inv, b * inv, a * inv],
		lumaVariance: Math.max(0, lumaSq * inv - meanLuma * meanLuma),
	};
}

function applySmoothFill(
	imageData: ImageDataLike,
	mask: Uint8Array,
	bounds: BoundsRect,
	initialColor: [number, number, number, number],
	options: HealRegionOptions,
): void {
	const solved = solveSmoothPatch(imageData, mask, bounds, initialColor, options.smoothIterations);
	writeSmoothPatch(imageData, mask, solved);
}

function solveSmoothPatch(
	imageData: ImageDataLike,
	mask: Uint8Array,
	bounds: BoundsRect,
	initialColor: [number, number, number, number],
	iterationOverride?: number,
): { rect: BoundsRect; width: number; height: number; data: Float32Array } {
	const { width, height, data } = imageData;
	const rect = expandBounds(bounds, width, height, 1);
	const localWidth = rect.width;
	const localHeight = rect.height;
	const localPixels = localWidth * localHeight;
	let prev = new Float32Array(localPixels * 4);
	let next = new Float32Array(localPixels * 4);
	const masked: number[] = [];

	for (let y = 0; y < localHeight; y++) {
		const globalY = rect.y + y;
		for (let x = 0; x < localWidth; x++) {
			const globalX = rect.x + x;
			const globalIndex = globalY * width + globalX;
			const localIndex = y * localWidth + x;
			const localOffset = localIndex * 4;
			const sourceOffset = globalIndex * 4;
			if (mask[globalIndex] === 0) {
				prev[localOffset] = data[sourceOffset];
				prev[localOffset + 1] = data[sourceOffset + 1];
				prev[localOffset + 2] = data[sourceOffset + 2];
				prev[localOffset + 3] = data[sourceOffset + 3];
			} else {
				masked.push(localIndex);
				prev[localOffset] = initialColor[0];
				prev[localOffset + 1] = initialColor[1];
				prev[localOffset + 2] = initialColor[2];
				prev[localOffset + 3] = initialColor[3];
			}
			next[localOffset] = prev[localOffset];
			next[localOffset + 1] = prev[localOffset + 1];
			next[localOffset + 2] = prev[localOffset + 2];
			next[localOffset + 3] = prev[localOffset + 3];
		}
	}

	const largestSide = Math.max(bounds.width, bounds.height);
	const iterations = Math.max(8, Math.round(iterationOverride ?? Math.min(2_000, Math.max(64, largestSide * largestSide * 2))));
	for (let iteration = 0; iteration < iterations; iteration++) {
		for (const localIndex of masked) {
			const x = localIndex % localWidth;
			const y = Math.floor(localIndex / localWidth);
			let count = 0;
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;

			if (x > 0) {
				const offset = (localIndex - 1) * 4;
				r += prev[offset];
				g += prev[offset + 1];
				b += prev[offset + 2];
				a += prev[offset + 3];
				count += 1;
			}
			if (x + 1 < localWidth) {
				const offset = (localIndex + 1) * 4;
				r += prev[offset];
				g += prev[offset + 1];
				b += prev[offset + 2];
				a += prev[offset + 3];
				count += 1;
			}
			if (y > 0) {
				const offset = (localIndex - localWidth) * 4;
				r += prev[offset];
				g += prev[offset + 1];
				b += prev[offset + 2];
				a += prev[offset + 3];
				count += 1;
			}
			if (y + 1 < localHeight) {
				const offset = (localIndex + localWidth) * 4;
				r += prev[offset];
				g += prev[offset + 1];
				b += prev[offset + 2];
				a += prev[offset + 3];
				count += 1;
			}

			const offset = localIndex * 4;
			const inv = count > 0 ? 1 / count : 0;
			next[offset] = count > 0 ? r * inv : prev[offset];
			next[offset + 1] = count > 0 ? g * inv : prev[offset + 1];
			next[offset + 2] = count > 0 ? b * inv : prev[offset + 2];
			next[offset + 3] = count > 0 ? a * inv : prev[offset + 3];
		}
		const swap = prev;
		prev = next;
		next = swap;
	}

	return { rect, width: localWidth, height: localHeight, data: prev };
}

function writeSmoothPatch(
	imageData: ImageDataLike,
	mask: Uint8Array,
	solved: { rect: BoundsRect; width: number; data: Float32Array },
): void {
	const { width, data } = imageData;
	for (let y = 0; y < solved.rect.height; y++) {
		const globalY = solved.rect.y + y;
		for (let x = 0; x < solved.rect.width; x++) {
			const globalX = solved.rect.x + x;
			const globalIndex = globalY * width + globalX;
			if (mask[globalIndex] === 0) continue;
			const sourceOffset = (y * solved.width + x) * 4;
			const targetOffset = globalIndex * 4;
			data[targetOffset] = clampByte(solved.data[sourceOffset]);
			data[targetOffset + 1] = clampByte(solved.data[sourceOffset + 1]);
			data[targetOffset + 2] = clampByte(solved.data[sourceOffset + 2]);
			data[targetOffset + 3] = clampByte(solved.data[sourceOffset + 3]);
		}
	}
}

function applyTextureFill(
	imageData: ImageDataLike,
	mask: Uint8Array,
	bounds: BoundsRect,
	boundaryStats: BoundaryStats,
	contextRadius: number,
	options: HealRegionOptions,
): boolean {
	const { width, height, data } = imageData;
	const patchSize = normalizePatchSize(options.texturePatchSize);
	const candidates = collectPatchOrigins(mask, width, height, bounds, patchSize, contextRadius);
	if (candidates.length === 0) return false;

	const maskedPixels = collectMaskedPixels(mask, width, bounds);
	if (maskedPixels.length === 0) return false;

	const localArea = bounds.width * bounds.height;
	const accum = new Float32Array(localArea * 4);
	const weights = new Float32Array(localArea);
	const seed = options.textureSeed ?? hashSeed(width, height, bounds, patchSize, boundaryStats.count);
	const random = mulberry32(seed);
	const half = Math.floor(patchSize / 2);
	const passes =
		options.texturePasses ?? Math.max(12, Math.ceil((maskedPixels.length / (patchSize * patchSize)) * 5));

	for (let pass = 0; pass < passes; pass++) {
		const anchor = maskedPixels[Math.floor(random() * maskedPixels.length)];
		const origin = candidates[Math.floor(random() * candidates.length)];
		for (let py = 0; py < patchSize; py++) {
			const targetY = anchor.y + py - half;
			if (targetY < bounds.y || targetY >= bounds.y + bounds.height) continue;
			const sourceY = origin.y + py;
			for (let px = 0; px < patchSize; px++) {
				const targetX = anchor.x + px - half;
				if (targetX < bounds.x || targetX >= bounds.x + bounds.width) continue;
				const targetIndex = targetY * width + targetX;
				if (mask[targetIndex] === 0) continue;
				const sourceX = origin.x + px;
				const sourceOffset = (sourceY * width + sourceX) * 4;
				const localIndex = (targetY - bounds.y) * bounds.width + targetX - bounds.x;
				const localOffset = localIndex * 4;
				const weight = patchWeight(px, py, patchSize);
				if (weights[localIndex] === 0) {
					accum[localOffset] = data[sourceOffset];
					accum[localOffset + 1] = data[sourceOffset + 1];
					accum[localOffset + 2] = data[sourceOffset + 2];
					accum[localOffset + 3] = data[sourceOffset + 3];
					weights[localIndex] = 1;
				} else {
					// Texture must keep its histogram; heavy averaging turns screentone into mud.
					const alpha = Math.min(0.18, weight * 0.18);
					accum[localOffset] = accum[localOffset] * (1 - alpha) + data[sourceOffset] * alpha;
					accum[localOffset + 1] = accum[localOffset + 1] * (1 - alpha) + data[sourceOffset + 1] * alpha;
					accum[localOffset + 2] = accum[localOffset + 2] * (1 - alpha) + data[sourceOffset + 2] * alpha;
					accum[localOffset + 3] = accum[localOffset + 3] * (1 - alpha) + data[sourceOffset + 3] * alpha;
				}
			}
		}
	}

	const contextPixels = collectContextPixels(mask, width, height, bounds, contextRadius);
	if (contextPixels.length === 0) return false;

	const edgeBlendRadius = Math.max(0, Math.round(options.edgeBlendRadius ?? 1));
	const distances = edgeBlendRadius > 0 ? computeMaskDistances(mask, width, height, bounds, edgeBlendRadius) : null;
	for (const pixel of maskedPixels) {
		const localIndex = (pixel.y - bounds.y) * bounds.width + pixel.x - bounds.x;
		const localOffset = localIndex * 4;
		let r: number;
		let g: number;
		let b: number;
		let a: number;
		if (weights[localIndex] > 0) {
			r = accum[localOffset];
			g = accum[localOffset + 1];
			b = accum[localOffset + 2];
			a = accum[localOffset + 3];
		} else {
			const sampleIndex = contextPixels[Math.floor(random() * contextPixels.length)];
			const sampleOffset = sampleIndex * 4;
			r = data[sampleOffset];
			g = data[sampleOffset + 1];
			b = data[sampleOffset + 2];
			a = data[sampleOffset + 3];
		}

		if (distances) {
			const distance = distances[localIndex];
			if (distance > 0 && distance <= edgeBlendRadius) {
				const edge = meanUnmaskedAround(imageData, mask, pixel.x, pixel.y, 1) ?? boundaryStats.mean;
				const textureWeight = Math.min(0.9, 0.65 + distance / (edgeBlendRadius + 1) * 0.25);
				r = r * textureWeight + edge[0] * (1 - textureWeight);
				g = g * textureWeight + edge[1] * (1 - textureWeight);
				b = b * textureWeight + edge[2] * (1 - textureWeight);
				a = a * textureWeight + edge[3] * (1 - textureWeight);
			}
		}

		const targetOffset = (pixel.y * width + pixel.x) * 4;
		data[targetOffset] = clampByte(r);
		data[targetOffset + 1] = clampByte(g);
		data[targetOffset + 2] = clampByte(b);
		data[targetOffset + 3] = clampByte(a);
	}

	return true;
}

function normalizePatchSize(value: number | undefined): number {
	const size = Math.max(3, Math.min(21, Math.round(value ?? 7)));
	return size % 2 === 0 ? size + 1 : size;
}

function collectPatchOrigins(
	mask: Uint8Array,
	width: number,
	height: number,
	bounds: BoundsRect,
	patchSize: number,
	contextRadius: number,
): PatchOrigin[] {
	const search = expandBounds(bounds, width, height, contextRadius);
	const origins: PatchOrigin[] = [];
	for (let y = search.y; y <= search.y + search.height - patchSize; y++) {
		for (let x = search.x; x <= search.x + search.width - patchSize; x++) {
			if (patchIntersectsMask(mask, width, x, y, patchSize)) continue;
			if (!patchIsNearMask(mask, width, height, x, y, patchSize, contextRadius)) continue;
			origins.push({ x, y });
		}
	}
	return origins;
}

function patchIntersectsMask(mask: Uint8Array, width: number, x: number, y: number, patchSize: number): boolean {
	for (let py = 0; py < patchSize; py++) {
		const row = (y + py) * width;
		for (let px = 0; px < patchSize; px++) {
			if (mask[row + x + px] !== 0) return true;
		}
	}
	return false;
}

function patchIsNearMask(
	mask: Uint8Array,
	width: number,
	height: number,
	x: number,
	y: number,
	patchSize: number,
	contextRadius: number,
): boolean {
	const half = Math.floor(patchSize / 2);
	return hasMaskedNeighbor(mask, width, height, x + half, y + half, contextRadius + half);
}

function collectMaskedPixels(mask: Uint8Array, width: number, bounds: BoundsRect): PatchOrigin[] {
	const pixels: PatchOrigin[] = [];
	for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
		const row = y * width;
		for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
			if (mask[row + x] !== 0) pixels.push({ x, y });
		}
	}
	return pixels;
}

function collectContextPixels(
	mask: Uint8Array,
	width: number,
	height: number,
	bounds: BoundsRect,
	radius: number,
): number[] {
	const search = expandBounds(bounds, width, height, radius);
	const pixels: number[] = [];
	for (let y = search.y; y < search.y + search.height; y++) {
		const row = y * width;
		for (let x = search.x; x < search.x + search.width; x++) {
			const pixelIndex = row + x;
			if (mask[pixelIndex] !== 0 || !hasMaskedNeighbor(mask, width, height, x, y, radius)) continue;
			pixels.push(pixelIndex);
		}
	}
	return pixels;
}

function computeMaskDistances(
	mask: Uint8Array,
	width: number,
	height: number,
	bounds: BoundsRect,
	maxDistance: number,
): Uint8Array {
	const distances = new Uint8Array(bounds.width * bounds.height);
	let frontier: PatchOrigin[] = [];
	for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
		const row = y * width;
		for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
			if (mask[row + x] === 0 || !touchesUnmasked(mask, width, height, x, y)) continue;
			const localIndex = (y - bounds.y) * bounds.width + x - bounds.x;
			distances[localIndex] = 1;
			frontier.push({ x, y });
		}
	}

	for (let distance = 2; distance <= maxDistance; distance++) {
		const nextFrontier: PatchOrigin[] = [];
		for (const pixel of frontier) {
			for (const neighbor of orthogonalNeighbors(pixel.x, pixel.y)) {
				if (
					neighbor.x < bounds.x ||
					neighbor.x >= bounds.x + bounds.width ||
					neighbor.y < bounds.y ||
					neighbor.y >= bounds.y + bounds.height
				) {
					continue;
				}
				const globalIndex = neighbor.y * width + neighbor.x;
				const localIndex = (neighbor.y - bounds.y) * bounds.width + neighbor.x - bounds.x;
				if (mask[globalIndex] === 0 || distances[localIndex] !== 0) continue;
				distances[localIndex] = distance;
				nextFrontier.push(neighbor);
			}
		}
		frontier = nextFrontier;
		if (frontier.length === 0) break;
	}

	return distances;
}

function touchesUnmasked(mask: Uint8Array, width: number, height: number, x: number, y: number): boolean {
	for (const neighbor of orthogonalNeighbors(x, y)) {
		if (neighbor.x < 0 || neighbor.x >= width || neighbor.y < 0 || neighbor.y >= height) return true;
		if (mask[neighbor.y * width + neighbor.x] === 0) return true;
	}
	return false;
}

function orthogonalNeighbors(x: number, y: number): PatchOrigin[] {
	return [
		{ x: x - 1, y },
		{ x: x + 1, y },
		{ x, y: y - 1 },
		{ x, y: y + 1 },
	];
}

function meanUnmaskedAround(
	imageData: ImageDataLike,
	mask: Uint8Array,
	x: number,
	y: number,
	radius: number,
): [number, number, number, number] | null {
	const { width, height, data } = imageData;
	let count = 0;
	let r = 0;
	let g = 0;
	let b = 0;
	let a = 0;
	for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++) {
		const row = yy * width;
		for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++) {
			const pixelIndex = row + xx;
			if (mask[pixelIndex] !== 0) continue;
			const offset = pixelIndex * 4;
			r += data[offset];
			g += data[offset + 1];
			b += data[offset + 2];
			a += data[offset + 3];
			count += 1;
		}
	}
	if (count === 0) return null;
	const inv = 1 / count;
	return [r * inv, g * inv, b * inv, a * inv];
}

function patchWeight(x: number, y: number, patchSize: number): number {
	const edge = Math.min(x + 1, y + 1, patchSize - x, patchSize - y);
	return edge / Math.ceil(patchSize / 2);
}

function expandBounds(bounds: BoundsRect, width: number, height: number, margin: number): BoundsRect {
	const x0 = Math.max(0, bounds.x - margin);
	const y0 = Math.max(0, bounds.y - margin);
	const x1 = Math.min(width, bounds.x + bounds.width + margin);
	const y1 = Math.min(height, bounds.y + bounds.height + margin);
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function hasMaskedNeighbor(
	mask: Uint8Array,
	width: number,
	height: number,
	x: number,
	y: number,
	radius: number,
): boolean {
	const y0 = Math.max(0, y - radius);
	const y1 = Math.min(height - 1, y + radius);
	const x0 = Math.max(0, x - radius);
	const x1 = Math.min(width - 1, x + radius);
	for (let yy = y0; yy <= y1; yy++) {
		const row = yy * width;
		for (let xx = x0; xx <= x1; xx++) {
			if (mask[row + xx] !== 0) return true;
		}
	}
	return false;
}

function toLuma(r: number, g: number, b: number): number {
	return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function clampByte(value: number): number {
	if (value <= 0) return 0;
	if (value >= 255) return 255;
	return Math.round(value);
}

function hashSeed(width: number, height: number, bounds: BoundsRect, patchSize: number, count: number): number {
	let seed = 0x811c9dc5;
	for (const value of [width, height, bounds.x, bounds.y, bounds.width, bounds.height, patchSize, count]) {
		seed ^= value;
		seed = Math.imul(seed, 0x01000193);
	}
	return seed >>> 0;
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state += 0x6d2b79f5;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}
