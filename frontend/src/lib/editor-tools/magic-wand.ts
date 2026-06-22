import MagicWand from "magic-wand-tool";

export interface MagicWandImageData {
	data: Uint8ClampedArray;
	width: number;
	height: number;
}

export interface MagicWandBounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface MagicWandMaskOptions {
	fillHoles?: boolean;
}

export interface MagicWandMaskResult {
	mask: Uint8Array;
	bounds: MagicWandBounds;
}

const EMPTY_BOUNDS: MagicWandBounds = { minX: 0, minY: 0, maxX: -1, maxY: -1 };
const SELECTED = 255;

export function magicWandMask(
	imageData: MagicWandImageData,
	x: number,
	y: number,
	tolerance: number,
	contiguous = true,
	options: Readonly<MagicWandMaskOptions> = {},
): MagicWandMaskResult {
	const width = normalizeDimension(imageData.width);
	const height = normalizeDimension(imageData.height);
	const empty = () => createEmptyResult(width, height);

	if (width <= 0 || height <= 0 || imageData.data.length < width * height * 4) return empty();
	if (!Number.isFinite(x) || !Number.isFinite(y)) return empty();

	const seedX = Math.round(x);
	const seedY = Math.round(y);
	if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return empty();

	const threshold = normalizeTolerance(tolerance);
	const baseResult = contiguous
		? contiguousMagicWandMask(imageData.data, width, height, seedX, seedY, threshold)
		: nonContiguousColorMask(imageData.data, width, height, seedX, seedY, threshold);

	if (!options.fillHoles || isEmptyBounds(baseResult.bounds)) return baseResult;

	return {
		mask: fillMaskHoles(baseResult.mask, width, height, baseResult.bounds),
		bounds: baseResult.bounds,
	};
}

function contiguousMagicWandMask(
	data: Uint8ClampedArray,
	width: number,
	height: number,
	seedX: number,
	seedY: number,
	tolerance: number,
): MagicWandMaskResult {
	const result = MagicWand.floodFill(
		{
			// The dependency accepts Uint8Array and only reads bytes; this view avoids copying image pixels.
			data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
			width,
			height,
			bytes: 4,
		},
		seedX,
		seedY,
		tolerance,
		null,
		false,
	);

	if (!result) return createEmptyResult(width, height);
	return normalizeLibraryMask(result.data, width, height);
}

function nonContiguousColorMask(
	data: Uint8ClampedArray,
	width: number,
	height: number,
	seedX: number,
	seedY: number,
	tolerance: number,
): MagicWandMaskResult {
	const mask = new Uint8Array(width * height);
	let bounds = emptyBounds();
	const sampleOffset = (seedY * width + seedX) * 4;
	const sampleR = data[sampleOffset] ?? 0;
	const sampleG = data[sampleOffset + 1] ?? 0;
	const sampleB = data[sampleOffset + 2] ?? 0;

	for (let py = 0; py < height; py++) {
		for (let px = 0; px < width; px++) {
			const offset = (py * width + px) * 4;
			// Match magic-wand-tool semantics: RGB channel thresholds only, alpha ignored.
			if (
				Math.abs((data[offset] ?? 0) - sampleR) <= tolerance &&
				Math.abs((data[offset + 1] ?? 0) - sampleG) <= tolerance &&
				Math.abs((data[offset + 2] ?? 0) - sampleB) <= tolerance
			) {
				mask[py * width + px] = SELECTED;
				bounds = includePoint(bounds, px, py);
			}
		}
	}

	return { mask, bounds: finalizeBounds(bounds) };
}

function normalizeLibraryMask(data: Uint8Array, width: number, height: number): MagicWandMaskResult {
	const mask = new Uint8Array(width * height);
	let bounds = emptyBounds();
	for (let index = 0; index < mask.length && index < data.length; index++) {
		if (data[index] === 0) continue;
		mask[index] = SELECTED;
		bounds = includePoint(bounds, index % width, Math.floor(index / width));
	}
	return { mask, bounds: finalizeBounds(bounds) };
}

function fillMaskHoles(mask: Uint8Array, width: number, height: number, bounds: MagicWandBounds): Uint8Array {
	const filled = new Uint8Array(mask);
	const boxWidth = bounds.maxX - bounds.minX + 1;
	const boxHeight = bounds.maxY - bounds.minY + 1;
	const visited = new Uint8Array(boxWidth * boxHeight);
	const queue = new Int32Array(boxWidth * boxHeight);
	let head = 0;
	let tail = 0;

	const enqueue = (localX: number, localY: number) => {
		if (localX < 0 || localY < 0 || localX >= boxWidth || localY >= boxHeight) return;
		const localIndex = localY * boxWidth + localX;
		if (visited[localIndex] !== 0) return;
		const imageIndex = (bounds.minY + localY) * width + bounds.minX + localX;
		if (filled[imageIndex] !== 0) return;
		visited[localIndex] = 1;
		queue[tail++] = localIndex;
	};

	for (let localX = 0; localX < boxWidth; localX++) {
		enqueue(localX, 0);
		enqueue(localX, boxHeight - 1);
	}
	for (let localY = 1; localY < boxHeight - 1; localY++) {
		enqueue(0, localY);
		enqueue(boxWidth - 1, localY);
	}

	while (head < tail) {
		const localIndex = queue[head++] ?? 0;
		const localX = localIndex % boxWidth;
		const localY = Math.floor(localIndex / boxWidth);
		enqueue(localX + 1, localY);
		enqueue(localX - 1, localY);
		enqueue(localX, localY + 1);
		enqueue(localX, localY - 1);
	}

	for (let localY = 0; localY < boxHeight; localY++) {
		for (let localX = 0; localX < boxWidth; localX++) {
			const localIndex = localY * boxWidth + localX;
			if (visited[localIndex] !== 0) continue;
			const imageIndex = (bounds.minY + localY) * width + bounds.minX + localX;
			if (filled[imageIndex] === 0) filled[imageIndex] = SELECTED;
		}
	}

	return filled;
}

function normalizeDimension(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.trunc(value));
}

function normalizeTolerance(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(255, Math.max(0, Math.round(value)));
}

function createEmptyResult(width: number, height: number): MagicWandMaskResult {
	return { mask: new Uint8Array(Math.max(0, width * height)), bounds: emptyBounds() };
}

function emptyBounds(): MagicWandBounds {
	return { ...EMPTY_BOUNDS };
}

function includePoint(bounds: MagicWandBounds, x: number, y: number): MagicWandBounds {
	if (isEmptyBounds(bounds)) return { minX: x, minY: y, maxX: x, maxY: y };
	if (x < bounds.minX) bounds.minX = x;
	if (y < bounds.minY) bounds.minY = y;
	if (x > bounds.maxX) bounds.maxX = x;
	if (y > bounds.maxY) bounds.maxY = y;
	return bounds;
}

function finalizeBounds(bounds: MagicWandBounds): MagicWandBounds {
	return isEmptyBounds(bounds) ? emptyBounds() : bounds;
}

function isEmptyBounds(bounds: MagicWandBounds): boolean {
	return bounds.maxX < bounds.minX || bounds.maxY < bounds.minY;
}
