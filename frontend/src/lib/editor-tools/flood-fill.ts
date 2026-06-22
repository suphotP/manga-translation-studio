export type RgbaColor = readonly [number, number, number, number];

export interface ImageDataLike {
	data: Uint8Array | Uint8ClampedArray;
	width: number;
	height: number;
}

export interface BoundsRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface FillResult {
	changed: boolean;
	boundsRect: BoundsRect | null;
	changedMask?: Uint8Array;
	changedPixels?: number;
}

export interface FloodFillOptions {
	tolerance?: number;
	contiguous?: boolean;
	antiAlias?: boolean;
	collectChangedMask?: boolean;
	yieldEveryPixels?: number;
}

interface BoundsAccumulator {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

interface NormalizedImage {
	data: Uint8Array | Uint8ClampedArray;
	width: number;
	height: number;
	pixels: number;
}

type SeedColor = readonly [number, number, number, number];

const BYTES_PER_PIXEL = 4;
const MAX_CHANNEL_VALUE = 255;
const DEFAULT_YIELD_EVERY_PIXELS = 512 * 1024;

interface ChangeTracker {
	mask: Uint8Array | null;
	pixels: number;
	collect: boolean;
}

export function floodFill(
	imageDataLike: ImageDataLike,
	x: number,
	y: number,
	color: RgbaColor,
	options: FloodFillOptions = {},
): FillResult {
	const image = normalizeImage(imageDataLike);
	const px = Math.floor(x);
	const py = Math.floor(y);
	if (px < 0 || py < 0 || px >= image.width || py >= image.height) return unchanged();

	const tolerance = normalizeTolerance(options.tolerance);
	const contiguous = options.contiguous ?? true;
	const antiAlias = options.antiAlias ?? false;
	const fillColor = normalizeColor(color);
	const seedOffset = pixelOffset(image.width, px, py);
	const seed: SeedColor = [
		image.data[seedOffset],
		image.data[seedOffset + 1],
		image.data[seedOffset + 2],
		image.data[seedOffset + 3],
	];
	const bounds = emptyBounds();
	const tracker = makeChangeTracker(image, options.collectChangedMask === true);

	if (contiguous) {
		scanlineFlood(image, px, py, seed, fillColor, tolerance, antiAlias, bounds, tracker);
	} else {
		fillAllMatchingPixels(image, seed, fillColor, tolerance, antiAlias, bounds, tracker);
	}

	return resultFromBounds(bounds, tracker);
}

export async function floodFillChunked(
	imageDataLike: ImageDataLike,
	x: number,
	y: number,
	color: RgbaColor,
	options: FloodFillOptions = {},
): Promise<FillResult> {
	const image = normalizeImage(imageDataLike);
	const px = Math.floor(x);
	const py = Math.floor(y);
	if (px < 0 || py < 0 || px >= image.width || py >= image.height) return unchanged();

	const tolerance = normalizeTolerance(options.tolerance);
	const contiguous = options.contiguous ?? true;
	const antiAlias = options.antiAlias ?? false;
	const fillColor = normalizeColor(color);
	const seedOffset = pixelOffset(image.width, px, py);
	const seed: SeedColor = [
		image.data[seedOffset],
		image.data[seedOffset + 1],
		image.data[seedOffset + 2],
		image.data[seedOffset + 3],
	];
	const bounds = emptyBounds();
	const tracker = makeChangeTracker(image, options.collectChangedMask === true);
	const yieldEveryPixels = normalizeYieldEveryPixels(options.yieldEveryPixels);

	if (contiguous) {
		await scanlineFloodChunked(image, px, py, seed, fillColor, tolerance, antiAlias, bounds, tracker, yieldEveryPixels);
	} else {
		await fillAllMatchingPixelsChunked(image, seed, fillColor, tolerance, antiAlias, bounds, tracker, yieldEveryPixels);
	}

	return resultFromBounds(bounds, tracker);
}

export function fillMask(imageDataLike: ImageDataLike, mask: Uint8Array, color: RgbaColor): FillResult {
	const image = normalizeImage(imageDataLike);
	if (mask.length !== image.pixels) {
		throw new Error(`fillMask: expected mask length ${image.pixels}, got ${mask.length}`);
	}

	const fillColor = normalizeColor(color);
	const bounds = emptyBounds();
	const tracker = makeChangeTracker(image, false);
	for (let index = 0; index < image.pixels; index++) {
		const coverage = mask[index] / MAX_CHANNEL_VALUE;
		if (coverage <= 0) continue;
		const offset = index * BYTES_PER_PIXEL;
		if (writeCoveredColor(image.data, offset, fillColor, coverage)) {
			const x = index % image.width;
			const y = Math.floor(index / image.width);
			expandBounds(bounds, x, y);
			markChanged(tracker, index);
		}
	}

	return resultFromBounds(bounds, tracker);
}

function scanlineFlood(
	image: NormalizedImage,
	startX: number,
	startY: number,
	seed: SeedColor,
	fillColor: SeedColor,
	tolerance: number,
	antiAlias: boolean,
	bounds: BoundsAccumulator,
	tracker: ChangeTracker,
): void {
	const visited = new Uint8Array(image.pixels);
	const stackX: number[] = [startX];
	const stackY: number[] = [startY];

	while (stackX.length > 0) {
		const seedX = stackX.pop();
		const y = stackY.pop();
		if (seedX === undefined || y === undefined) continue;

		let x = seedX;
		while (x >= 0 && !isVisited(visited, image.width, x, y) && pixelMatches(image.data, pixelOffset(image.width, x, y), seed, tolerance)) {
			x--;
		}
		x++;

		let spanAbove = false;
		let spanBelow = false;
		while (x < image.width && !isVisited(visited, image.width, x, y)) {
			const offset = pixelOffset(image.width, x, y);
			if (!pixelMatches(image.data, offset, seed, tolerance)) break;
			const distance = antiAlias ? pixelDistance(image.data, offset, seed) : 0;

			const index = y * image.width + x;
			visited[index] = 1;
			const coverage = coverageForDistance(distance, tolerance, antiAlias);
			if (coverage > 0 && writeCoveredColor(image.data, offset, fillColor, coverage)) {
				expandBounds(bounds, x, y);
				markChanged(tracker, index);
			}

			if (y > 0) {
				const aboveIndex = index - image.width;
				const aboveMatches = visited[aboveIndex] === 0 && pixelMatches(image.data, aboveIndex * BYTES_PER_PIXEL, seed, tolerance);
				if (aboveMatches && !spanAbove) {
					stackX.push(x);
					stackY.push(y - 1);
					spanAbove = true;
				} else if (!aboveMatches) {
					spanAbove = false;
				}
			}

			if (y + 1 < image.height) {
				const belowIndex = index + image.width;
				const belowMatches = visited[belowIndex] === 0 && pixelMatches(image.data, belowIndex * BYTES_PER_PIXEL, seed, tolerance);
				if (belowMatches && !spanBelow) {
					stackX.push(x);
					stackY.push(y + 1);
					spanBelow = true;
				} else if (!belowMatches) {
					spanBelow = false;
				}
			}

			x++;
		}
	}
}

function fillAllMatchingPixels(
	image: NormalizedImage,
	seed: SeedColor,
	fillColor: SeedColor,
	tolerance: number,
	antiAlias: boolean,
	bounds: BoundsAccumulator,
	tracker: ChangeTracker,
): void {
	let index = 0;
	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < image.width; x++, index++) {
			const offset = index * BYTES_PER_PIXEL;
			if (!pixelMatches(image.data, offset, seed, tolerance)) continue;
			const distance = antiAlias ? pixelDistance(image.data, offset, seed) : 0;
			const coverage = coverageForDistance(distance, tolerance, antiAlias);
			if (coverage <= 0) continue;
			if (writeCoveredColor(image.data, offset, fillColor, coverage)) {
				expandBounds(bounds, x, y);
				markChanged(tracker, index);
			}
		}
	}
}

async function scanlineFloodChunked(
	image: NormalizedImage,
	startX: number,
	startY: number,
	seed: SeedColor,
	fillColor: SeedColor,
	tolerance: number,
	antiAlias: boolean,
	bounds: BoundsAccumulator,
	tracker: ChangeTracker,
	yieldEveryPixels: number,
): Promise<void> {
	const visited = new Uint8Array(image.pixels);
	const stackX: number[] = [startX];
	const stackY: number[] = [startY];
	let processed = 0;

	while (stackX.length > 0) {
		const seedX = stackX.pop();
		const y = stackY.pop();
		if (seedX === undefined || y === undefined) continue;

		let x = seedX;
		while (x >= 0 && !isVisited(visited, image.width, x, y) && pixelMatches(image.data, pixelOffset(image.width, x, y), seed, tolerance)) {
			x--;
		}
		x++;

		let spanAbove = false;
		let spanBelow = false;
		while (x < image.width && !isVisited(visited, image.width, x, y)) {
			const offset = pixelOffset(image.width, x, y);
			if (!pixelMatches(image.data, offset, seed, tolerance)) break;
			const distance = antiAlias ? pixelDistance(image.data, offset, seed) : 0;

			const index = y * image.width + x;
			visited[index] = 1;
			const coverage = coverageForDistance(distance, tolerance, antiAlias);
			if (coverage > 0 && writeCoveredColor(image.data, offset, fillColor, coverage)) {
				expandBounds(bounds, x, y);
				markChanged(tracker, index);
			}

			if (y > 0) {
				const aboveIndex = index - image.width;
				const aboveMatches = visited[aboveIndex] === 0 && pixelMatches(image.data, aboveIndex * BYTES_PER_PIXEL, seed, tolerance);
				if (aboveMatches && !spanAbove) {
					stackX.push(x);
					stackY.push(y - 1);
					spanAbove = true;
				} else if (!aboveMatches) {
					spanAbove = false;
				}
			}

			if (y + 1 < image.height) {
				const belowIndex = index + image.width;
				const belowMatches = visited[belowIndex] === 0 && pixelMatches(image.data, belowIndex * BYTES_PER_PIXEL, seed, tolerance);
				if (belowMatches && !spanBelow) {
					stackX.push(x);
					stackY.push(y + 1);
					spanBelow = true;
				} else if (!belowMatches) {
					spanBelow = false;
				}
			}

			x++;
			processed++;
			if (processed >= yieldEveryPixels) {
				processed = 0;
				await yieldToMainThread();
			}
		}
	}
}

async function fillAllMatchingPixelsChunked(
	image: NormalizedImage,
	seed: SeedColor,
	fillColor: SeedColor,
	tolerance: number,
	antiAlias: boolean,
	bounds: BoundsAccumulator,
	tracker: ChangeTracker,
	yieldEveryPixels: number,
): Promise<void> {
	let index = 0;
	let processed = 0;
	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < image.width; x++, index++) {
			const offset = index * BYTES_PER_PIXEL;
			if (pixelMatches(image.data, offset, seed, tolerance)) {
				const distance = antiAlias ? pixelDistance(image.data, offset, seed) : 0;
				const coverage = coverageForDistance(distance, tolerance, antiAlias);
				if (coverage > 0 && writeCoveredColor(image.data, offset, fillColor, coverage)) {
					expandBounds(bounds, x, y);
					markChanged(tracker, index);
				}
			}
			processed++;
			if (processed >= yieldEveryPixels) {
				processed = 0;
				await yieldToMainThread();
			}
		}
	}
}

function normalizeImage(imageDataLike: ImageDataLike): NormalizedImage {
	const width = normalizeDimension(imageDataLike.width, "width");
	const height = normalizeDimension(imageDataLike.height, "height");
	const pixels = width * height;
	const expectedLength = pixels * BYTES_PER_PIXEL;
	if (imageDataLike.data.length < expectedLength) {
		throw new Error(`floodFill: expected image data length at least ${expectedLength}, got ${imageDataLike.data.length}`);
	}
	return { data: imageDataLike.data, width, height, pixels };
}

function normalizeDimension(value: number, label: "width" | "height"): number {
	if (!Number.isFinite(value) || value < 0 || Math.floor(value) !== value) {
		throw new Error(`floodFill: ${label} must be a non-negative integer`);
	}
	return value;
}

function normalizeTolerance(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 0;
	return clampByte(Math.round(value));
}

function normalizeColor(color: RgbaColor): SeedColor {
	return [
		clampByte(Math.round(color[0])),
		clampByte(Math.round(color[1])),
		clampByte(Math.round(color[2])),
		clampByte(Math.round(color[3])),
	];
}

function clampByte(value: number): number {
	if (value <= 0) return 0;
	if (value >= MAX_CHANNEL_VALUE) return MAX_CHANNEL_VALUE;
	return value;
}

function pixelOffset(width: number, x: number, y: number): number {
	return (y * width + x) * BYTES_PER_PIXEL;
}

function isVisited(visited: Uint8Array, width: number, x: number, y: number): boolean {
	return visited[y * width + x] !== 0;
}

function pixelDistance(data: Uint8Array | Uint8ClampedArray, offset: number, seed: SeedColor): number {
	return Math.max(
		Math.abs(data[offset] - seed[0]),
		Math.abs(data[offset + 1] - seed[1]),
		Math.abs(data[offset + 2] - seed[2]),
		Math.abs(data[offset + 3] - seed[3]),
	);
}

function pixelMatches(data: Uint8Array | Uint8ClampedArray, offset: number, seed: SeedColor, tolerance: number): boolean {
	if (tolerance <= 0) {
		return (
			data[offset] === seed[0] &&
			data[offset + 1] === seed[1] &&
			data[offset + 2] === seed[2] &&
			data[offset + 3] === seed[3]
		);
	}
	if (Math.abs(data[offset] - seed[0]) > tolerance) return false;
	if (Math.abs(data[offset + 1] - seed[1]) > tolerance) return false;
	if (Math.abs(data[offset + 2] - seed[2]) > tolerance) return false;
	return Math.abs(data[offset + 3] - seed[3]) <= tolerance;
}

function coverageForDistance(distance: number, tolerance: number, antiAlias: boolean): number {
	if (!antiAlias || tolerance <= 0) return 1;
	// Only the outer band fades; interior pixels stay solid so a bucket fill does
	// not wash out large flat regions when tolerance is raised to catch AA edges.
	const fadeWidth = Math.max(1, Math.ceil(tolerance * 0.25));
	const fadeStart = Math.max(0, tolerance - fadeWidth);
	if (distance <= fadeStart) return 1;
	return Math.max(1 / (fadeWidth + 1), (tolerance - distance + 1) / (fadeWidth + 1));
}

function writeCoveredColor(
	data: Uint8Array | Uint8ClampedArray,
	offset: number,
	color: SeedColor,
	coverage: number,
): boolean {
	if (coverage >= 1) return writeSolidColor(data, offset, color);
	const alpha = clampByte(Math.round(color[3] * Math.max(0, Math.min(1, coverage))));
	if (
		data[offset] === color[0] &&
		data[offset + 1] === color[1] &&
		data[offset + 2] === color[2] &&
		data[offset + 3] === alpha
	) {
		return false;
	}

	data[offset] = color[0];
	data[offset + 1] = color[1];
	data[offset + 2] = color[2];
	data[offset + 3] = alpha;
	return true;
}

function writeSolidColor(data: Uint8Array | Uint8ClampedArray, offset: number, color: SeedColor): boolean {
	if (
		data[offset] === color[0] &&
		data[offset + 1] === color[1] &&
		data[offset + 2] === color[2] &&
		data[offset + 3] === color[3]
	) {
		return false;
	}

	data[offset] = color[0];
	data[offset + 1] = color[1];
	data[offset + 2] = color[2];
	data[offset + 3] = color[3];
	return true;
}

function makeChangeTracker(image: NormalizedImage, collect: boolean): ChangeTracker {
	return { mask: collect ? new Uint8Array(image.pixels) : null, pixels: 0, collect };
}

function markChanged(tracker: ChangeTracker, index: number): void {
	tracker.pixels += 1;
	if (tracker.mask) tracker.mask[index] = 1;
}

function emptyBounds(): BoundsAccumulator {
	return { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: -1, maxY: -1 };
}

function expandBounds(bounds: BoundsAccumulator, x: number, y: number): void {
	if (x < bounds.minX) bounds.minX = x;
	if (y < bounds.minY) bounds.minY = y;
	if (x > bounds.maxX) bounds.maxX = x;
	if (y > bounds.maxY) bounds.maxY = y;
}

function resultFromBounds(bounds: BoundsAccumulator, tracker?: ChangeTracker): FillResult {
	if (bounds.maxX < bounds.minX || bounds.maxY < bounds.minY) return unchanged();
	const result: FillResult = {
		changed: true,
		boundsRect: {
			x: bounds.minX,
			y: bounds.minY,
			width: bounds.maxX - bounds.minX + 1,
			height: bounds.maxY - bounds.minY + 1,
		},
	};
	if (tracker?.collect) {
		result.changedMask = tracker.mask ?? undefined;
		result.changedPixels = tracker.pixels;
	}
	return result;
}

function unchanged(): FillResult {
	return { changed: false, boundsRect: null };
}

function normalizeYieldEveryPixels(value: number | undefined): number {
	if (value === undefined) return DEFAULT_YIELD_EVERY_PIXELS;
	if (!Number.isFinite(value) || value <= 0) return Number.POSITIVE_INFINITY;
	return Math.max(1, Math.floor(value));
}

async function yieldToMainThread(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
