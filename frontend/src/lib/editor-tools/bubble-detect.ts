export interface ImageDataLike {
	readonly width: number;
	readonly height: number;
	readonly data: ArrayLike<number>;
}

export interface BubblePoint {
	readonly x: number;
	readonly y: number;
}

export interface BubbleBounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface BubbleCandidate {
	readonly mask: Uint8Array;
	readonly bounds: BubbleBounds;
	readonly score: number;
}

interface NormalizedImage {
	readonly width: number;
	readonly height: number;
	readonly data: ArrayLike<number>;
}

interface Component {
	readonly area: number;
	readonly pixels: number[];
	readonly bounds: BubbleBounds;
	readonly tooLarge: boolean;
}

interface ComponentGeometry {
	readonly mask: Uint8Array;
	readonly perimeter: number;
	readonly boundaryPixels: number[];
}

const BRIGHT_THRESHOLD = 240;
const DARK_INK_THRESHOLD = 130;
const CLEAN_EXPAND_RADIUS = 2;

/**
 * Detect likely speech bubbles from bright connected components.
 *
 * This is intentionally heuristic and fail-closed: one-click cleaning is safer
 * when uncertain white regions are ignored instead of turning a full page into a
 * clean mask.
 */
export function detectBubbles(imageDataLike: ImageDataLike): BubbleCandidate[] {
	const image = normalizeImage(imageDataLike);
	if (!image) return [];

	const { width, height } = image;
	const total = width * height;
	const bright = buildBrightMask(image);
	const visited = new Uint8Array(total);
	const queue = new Int32Array(total);
	const minArea = minimumBubbleArea(total);
	const maxArea = maximumBubbleArea(total, minArea);
	const candidates: BubbleCandidate[] = [];

	for (let seed = 0; seed < total; seed++) {
		if (!bright[seed] || visited[seed]) continue;
		const component = floodBrightComponent(bright, visited, width, height, seed, queue, maxArea);
		if (component.tooLarge || component.area < minArea || component.area > maxArea) continue;

		const geometry = buildComponentGeometry(component, width, height);
		if (geometry.perimeter === 0 || geometry.boundaryPixels.length < 4) continue;

		const holeResult = fillInternalHoles(image, geometry.mask, component.bounds);
		const darkInkScore = scoreInteriorInk(holeResult.darkInkPixels, component.area + holeResult.holePixels);
		if (darkInkScore === 0) continue;

		const shapePerimeter = holeResult.externalPerimeter || geometry.perimeter;
		const roundness = clamp01((4 * Math.PI * component.area) / (shapePerimeter * shapePerimeter));
		const solidity = computeSolidity(component.area, geometry.boundaryPixels, width);
		const score = clamp01(0.45 * roundness + 0.35 * solidity + 0.2 * darkInkScore);

		if (roundness < 0.28 || solidity < 0.55 || score < 0.48) continue;
		candidates.push({
			mask: holeResult.mask,
			bounds: component.bounds,
			score: roundScore(score),
		});
	}

	return candidates.sort((a, b) => b.score - a.score);
}

/**
 * Build the clean mask for the bubble under a click.
 *
 * The mask is image-sized, binary 0/255, and includes enclosed dark text holes.
 * It expands by 2px so a cleaner can cover anti-aliased ink edges without asking
 * the user to precisely paint around every glyph.
 */
export function suggestCleanMask(imageDataLike: ImageDataLike, clickPoint: BubblePoint): Uint8Array {
	const image = normalizeImage(imageDataLike);
	if (!image) return new Uint8Array(0);

	const { width, height } = image;
	const total = width * height;
	const empty = new Uint8Array(total);
	const x = Math.round(clickPoint.x);
	const y = Math.round(clickPoint.y);
	if (x < 0 || y < 0 || x >= width || y >= height) return empty;

	const bright = buildBrightMask(image);
	const seed = y * width + x;
	if (!bright[seed]) return empty;

	const visited = new Uint8Array(total);
	const queue = new Int32Array(total);
	const maxArea = Math.max(64, Math.floor(total * 0.55));
	const component = floodBrightComponent(bright, visited, width, height, seed, queue, maxArea);
	if (component.tooLarge || component.area > maxArea) return empty;

	const geometry = buildComponentGeometry(component, width, height);
	const filled = fillInternalHoles(image, geometry.mask, component.bounds).mask;
	return dilateMask(filled, width, height, CLEAN_EXPAND_RADIUS);
}

function normalizeImage(image: ImageDataLike): NormalizedImage | null {
	const width = Math.trunc(image.width);
	const height = Math.trunc(image.height);
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
	const totalBytes = width * height * 4;
	if (!image.data || image.data.length < totalBytes) return null;
	return { width, height, data: image.data };
}

function buildBrightMask(image: NormalizedImage): Uint8Array {
	const total = image.width * image.height;
	const bright = new Uint8Array(total);
	for (let i = 0; i < total; i++) {
		const o = i * 4;
		if (alphaAt(image.data, o) > 0 && lumaAt(image.data, o) > BRIGHT_THRESHOLD) bright[i] = 1;
	}
	return bright;
}

function floodBrightComponent(
	bright: Uint8Array,
	visited: Uint8Array,
	width: number,
	height: number,
	seed: number,
	queue: Int32Array,
	maxPixelsToKeep: number,
): Component {
	let head = 0;
	let tail = 0;
	let area = 0;
	let tooLarge = false;
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	const pixels: number[] = [];

	visited[seed] = 1;
	queue[tail++] = seed;

	while (head < tail) {
		const idx = queue[head++];
		const x = idx % width;
		const y = (idx - x) / width;
		area++;
		if (!tooLarge) {
			pixels.push(idx);
			if (pixels.length > maxPixelsToKeep) {
				pixels.length = 0;
				tooLarge = true;
			}
		}
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;

		if (x > 0) tail = enqueueBright(idx - 1, bright, visited, queue, tail);
		if (x + 1 < width) tail = enqueueBright(idx + 1, bright, visited, queue, tail);
		if (y > 0) tail = enqueueBright(idx - width, bright, visited, queue, tail);
		if (y + 1 < height) tail = enqueueBright(idx + width, bright, visited, queue, tail);
	}

	return {
		area,
		pixels,
		bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
		tooLarge,
	};
}

function enqueueBright(
	idx: number,
	bright: Uint8Array,
	visited: Uint8Array,
	queue: Int32Array,
	tail: number,
): number {
	if (!bright[idx] || visited[idx]) return tail;
	visited[idx] = 1;
	queue[tail] = idx;
	return tail + 1;
}

function buildComponentGeometry(component: Component, width: number, height: number): ComponentGeometry {
	const total = width * height;
	const mask = new Uint8Array(total);
	for (const idx of component.pixels) mask[idx] = 255;

	let perimeter = 0;
	const boundaryPixels: number[] = [];
	for (const idx of component.pixels) {
		const x = idx % width;
		const y = (idx - x) / width;
		let edgeCount = 0;
		if (x === 0 || mask[idx - 1] === 0) edgeCount++;
		if (x + 1 === width || mask[idx + 1] === 0) edgeCount++;
		if (y === 0 || mask[idx - width] === 0) edgeCount++;
		if (y + 1 === height || mask[idx + width] === 0) edgeCount++;
		if (edgeCount > 0) {
			perimeter += edgeCount;
			boundaryPixels.push(idx);
		}
	}

	return { mask, perimeter, boundaryPixels };
}

function fillInternalHoles(
	image: NormalizedImage,
	componentMask: Uint8Array,
	bounds: BubbleBounds,
): { mask: Uint8Array; holePixels: number; darkInkPixels: number; externalPerimeter: number } {
	const { width, height, data } = image;
	const out = componentMask.slice();
	const seenExterior = new Uint8Array(width * height);
	const queue = new Int32Array(width * height);
	const x0 = Math.max(0, bounds.x - 1);
	const y0 = Math.max(0, bounds.y - 1);
	const x1 = Math.min(width - 1, bounds.x + bounds.width);
	const y1 = Math.min(height - 1, bounds.y + bounds.height);
	let head = 0;
	let tail = 0;

	const pushExterior = (x: number, y: number) => {
		const idx = y * width + x;
		if (out[idx] || seenExterior[idx]) return;
		seenExterior[idx] = 1;
		queue[tail++] = idx;
	};

	for (let x = x0; x <= x1; x++) {
		pushExterior(x, y0);
		pushExterior(x, y1);
	}
	for (let y = y0; y <= y1; y++) {
		pushExterior(x0, y);
		pushExterior(x1, y);
	}

	while (head < tail) {
		const idx = queue[head++];
		const x = idx % width;
		const y = (idx - x) / width;
		if (x > x0) pushExterior(x - 1, y);
		if (x < x1) pushExterior(x + 1, y);
		if (y > y0) pushExterior(x, y - 1);
		if (y < y1) pushExterior(x, y + 1);
	}

	let holePixels = 0;
	let darkInkPixels = 0;
	for (let y = y0; y <= y1; y++) {
		const row = y * width;
		for (let x = x0; x <= x1; x++) {
			const idx = row + x;
			if (out[idx] || seenExterior[idx]) continue;
			out[idx] = 255;
			holePixels++;
			if (lumaAt(data, idx * 4) < DARK_INK_THRESHOLD) darkInkPixels++;
		}
	}

	return {
		mask: out,
		holePixels,
		darkInkPixels,
		externalPerimeter: countExternalPerimeter(componentMask, seenExterior, width, height),
	};
}

function countExternalPerimeter(
	componentMask: Uint8Array,
	seenExterior: Uint8Array,
	width: number,
	height: number,
): number {
	let perimeter = 0;
	for (let idx = 0; idx < componentMask.length; idx++) {
		if (!componentMask[idx]) continue;
		const x = idx % width;
		const y = (idx - x) / width;
		if (x === 0 || seenExterior[idx - 1]) perimeter++;
		if (x + 1 === width || seenExterior[idx + 1]) perimeter++;
		if (y === 0 || seenExterior[idx - width]) perimeter++;
		if (y + 1 === height || seenExterior[idx + width]) perimeter++;
	}
	return perimeter;
}

function scoreInteriorInk(darkInkPixels: number, filledArea: number): number {
	const minInkPixels = Math.max(3, Math.floor(filledArea * 0.002));
	if (darkInkPixels < minInkPixels) return 0;
	return clamp01(darkInkPixels / Math.max(1, filledArea * 0.12));
}

function computeSolidity(area: number, boundaryPixels: number[], width: number): number {
	const hullArea = computeConvexHullArea(boundaryPixels, width);
	if (hullArea <= 0) return 0;
	return clamp01(area / hullArea);
}

function computeConvexHullArea(boundaryPixels: number[], width: number): number {
	const cornerKeys = new Set<number>();
	const stride = width + 1;
	for (const idx of boundaryPixels) {
		const x = idx % width;
		const y = (idx - x) / width;
		cornerKeys.add(y * stride + x);
		cornerKeys.add(y * stride + x + 1);
		cornerKeys.add((y + 1) * stride + x);
		cornerKeys.add((y + 1) * stride + x + 1);
	}

	const points = [...cornerKeys]
		.map((key) => ({ x: key % stride, y: Math.floor(key / stride) }))
		.sort((a, b) => a.x - b.x || a.y - b.y);
	if (points.length < 3) return 0;

	const lower: BubblePoint[] = [];
	for (const point of points) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
			lower.pop();
		}
		lower.push(point);
	}

	const upper: BubblePoint[] = [];
	for (let i = points.length - 1; i >= 0; i--) {
		const point = points[i];
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
			upper.pop();
		}
		upper.push(point);
	}

	const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
	if (hull.length < 3) return 0;

	let twiceArea = 0;
	for (let i = 0; i < hull.length; i++) {
		const a = hull[i];
		const b = hull[(i + 1) % hull.length];
		twiceArea += a.x * b.y - b.x * a.y;
	}
	return Math.abs(twiceArea) / 2;
}

function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
	const r = Math.max(0, Math.round(radius));
	if (r === 0) return mask.slice();
	const out = new Uint8Array(width * height);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let filled = false;
			for (let yy = Math.max(0, y - r); yy <= Math.min(height - 1, y + r) && !filled; yy++) {
				const row = yy * width;
				for (let xx = Math.max(0, x - r); xx <= Math.min(width - 1, x + r); xx++) {
					if (mask[row + xx]) {
						filled = true;
						break;
					}
				}
			}
			if (filled) out[y * width + x] = 255;
		}
	}

	return out;
}

function minimumBubbleArea(totalPixels: number): number {
	return Math.max(32, Math.floor(totalPixels * 0.0015));
}

function maximumBubbleArea(totalPixels: number, minimum: number): number {
	return Math.max(minimum + 1, Math.floor(totalPixels * 0.45));
}

function lumaAt(data: ArrayLike<number>, offset: number): number {
	return 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
}

function alphaAt(data: ArrayLike<number>, offset: number): number {
	const alpha = data[offset + 3];
	return alpha === undefined ? 255 : alpha;
}

function cross(a: BubblePoint, b: BubblePoint, c: BubblePoint): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function roundScore(score: number): number {
	return Math.round(score * 1000) / 1000;
}
