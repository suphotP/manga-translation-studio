export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface ImageDataLike {
	width: number;
	height: number;
	data: ArrayLike<number>;
}

export type PanelReadingOrder = "manga" | "ltr";

export interface PanelDetectOptions {
	readingOrder?: PanelReadingOrder;
	blackThreshold?: number;
	alphaThreshold?: number;
	gutterMaxBlackRatio?: number;
	minGutterSize?: number;
	maxGutterSize?: number;
	minPanelWidthRatio?: number;
	minPanelHeightRatio?: number;
	minPanelAreaRatio?: number;
	maxDepth?: number;
}

interface NormalizedImage {
	width: number;
	height: number;
	data: ArrayLike<number>;
	channels: 1 | 4;
}

interface NormalizedOptions {
	readingOrder: PanelReadingOrder;
	blackThreshold: number;
	alphaThreshold: number;
	gutterMaxBlackRatio: number;
	minGutterSize: number;
	maxGutterSize: number;
	minPanelWidth: number;
	minPanelHeight: number;
	minPanelArea: number;
	maxDepth: number;
}

interface GutterCandidate {
	axis: "x" | "y";
	start: number;
	end: number;
	score: number;
	averageBlackRatio: number;
}

const DEFAULT_BLACK_THRESHOLD = 96;
const DEFAULT_ALPHA_THRESHOLD = 16;
const DEFAULT_GUTTER_BLACK_RATIO = 0.0025;
const DEFAULT_MAX_GUTTER_RATIO = 0.22;
const DEFAULT_MIN_PANEL_WIDTH_RATIO = 0.08;
const DEFAULT_MIN_PANEL_HEIGHT_RATIO = 0.08;
const DEFAULT_MIN_PANEL_AREA_RATIO = 0.015;
const DEFAULT_MAX_DEPTH = 12;

export function detectPanels(imageDataLike: ImageDataLike | null | undefined, options: PanelDetectOptions = {}): Rect[] {
	const image = normalizeImage(imageDataLike);
	if (!image) return [];

	const normalizedOptions = normalizeOptions(image.width, image.height, options);
	const blackMask = binarizeBlackPixels(image, normalizedOptions);
	const leaves = subdivideRect({ x: 0, y: 0, w: image.width, h: image.height }, blackMask, image.width, normalizedOptions, 0);
	const panels = uniqueRects(
		leaves
			.map((rect) => trimToBlackBounds(rect, blackMask, image.width))
			.filter((rect): rect is Rect => rect !== null)
			.filter((rect) => isPanelSize(rect, normalizedOptions))
			.filter((rect) => hasPanelFrameEvidence(rect, blackMask, image.width)),
	);

	return orderPanels(panels, normalizedOptions.readingOrder);
}

function normalizeImage(imageDataLike: ImageDataLike | null | undefined): NormalizedImage | null {
	if (!imageDataLike) return null;
	const width = Math.floor(Number(imageDataLike.width));
	const height = Math.floor(Number(imageDataLike.height));
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
	const pixelCount = width * height;
	const data = imageDataLike.data;
	if (!data || data.length < pixelCount) return null;
	return {
		width,
		height,
		data,
		channels: data.length >= pixelCount * 4 ? 4 : 1,
	};
}

function normalizeOptions(width: number, height: number, options: PanelDetectOptions): NormalizedOptions {
	const minSide = Math.min(width, height);
	const minGutterSize = clampInteger(options.minGutterSize ?? Math.max(3, Math.round(minSide * 0.015)), 1, minSide);
	const maxGutterSize = clampInteger(
		options.maxGutterSize ?? Math.max(minGutterSize, Math.round(minSide * DEFAULT_MAX_GUTTER_RATIO)),
		minGutterSize,
		Math.max(minGutterSize, minSide),
	);
	return {
		readingOrder: options.readingOrder ?? "manga",
		blackThreshold: clampNumber(options.blackThreshold ?? DEFAULT_BLACK_THRESHOLD, 0, 255),
		alphaThreshold: clampNumber(options.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD, 0, 255),
		gutterMaxBlackRatio: clampNumber(options.gutterMaxBlackRatio ?? DEFAULT_GUTTER_BLACK_RATIO, 0, 0.2),
		minGutterSize,
		maxGutterSize,
		minPanelWidth: Math.max(1, Math.round(width * (options.minPanelWidthRatio ?? DEFAULT_MIN_PANEL_WIDTH_RATIO))),
		minPanelHeight: Math.max(1, Math.round(height * (options.minPanelHeightRatio ?? DEFAULT_MIN_PANEL_HEIGHT_RATIO))),
		minPanelArea: Math.max(1, Math.round(width * height * (options.minPanelAreaRatio ?? DEFAULT_MIN_PANEL_AREA_RATIO))),
		maxDepth: clampInteger(options.maxDepth ?? DEFAULT_MAX_DEPTH, 1, 32),
	};
}

function binarizeBlackPixels(image: NormalizedImage, options: NormalizedOptions): Uint8Array {
	const blackMask = new Uint8Array(image.width * image.height);
	for (let index = 0; index < blackMask.length; index++) {
		const offset = image.channels === 4 ? index * 4 : index;
		const alpha = image.channels === 4 ? valueAt(image.data, offset + 3, 255) : 255;
		if (alpha <= options.alphaThreshold) continue;
		const red = valueAt(image.data, offset, 255);
		const green = image.channels === 4 ? valueAt(image.data, offset + 1, red) : red;
		const blue = image.channels === 4 ? valueAt(image.data, offset + 2, red) : red;
		const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722;
		blackMask[index] = luma <= options.blackThreshold ? 1 : 0;
	}
	return blackMask;
}

function subdivideRect(rect: Rect, blackMask: Uint8Array, imageWidth: number, options: NormalizedOptions, depth: number): Rect[] {
	if (depth >= options.maxDepth || rect.w < options.minPanelWidth * 2 || rect.h < options.minPanelHeight * 2) return [rect];

	const gutter = findBestGutter(rect, blackMask, imageWidth, options);
	if (!gutter) return [rect];

	const children =
		gutter.axis === "x"
			? [
					{ x: rect.x, y: rect.y, w: gutter.start - rect.x, h: rect.h },
					{ x: gutter.end, y: rect.y, w: rect.x + rect.w - gutter.end, h: rect.h },
				]
			: [
					{ x: rect.x, y: rect.y, w: rect.w, h: gutter.start - rect.y },
					{ x: rect.x, y: gutter.end, w: rect.w, h: rect.y + rect.h - gutter.end },
				];

	return children
		.filter((child) => child.w >= options.minPanelWidth && child.h >= options.minPanelHeight)
		.flatMap((child) => subdivideRect(child, blackMask, imageWidth, options, depth + 1));
}

function findBestGutter(rect: Rect, blackMask: Uint8Array, imageWidth: number, options: NormalizedOptions): GutterCandidate | null {
	const vertical = findAxisGutter("x", rect, blackMask, imageWidth, options);
	const horizontal = findAxisGutter("y", rect, blackMask, imageWidth, options);
	if (!vertical) return horizontal;
	if (!horizontal) return vertical;
	return vertical.score >= horizontal.score ? vertical : horizontal;
}

function findAxisGutter(
	axis: "x" | "y",
	rect: Rect,
	blackMask: Uint8Array,
	imageWidth: number,
	options: NormalizedOptions,
): GutterCandidate | null {
	const span = axis === "x" ? rect.w : rect.h;
	const cross = axis === "x" ? rect.h : rect.w;
	const minPanelSide = axis === "x" ? options.minPanelWidth : options.minPanelHeight;
	if (span < minPanelSide * 2 + options.minGutterSize) return null;

	let best: GutterCandidate | null = null;
	let runStart = -1;
	let runBlackTotal = 0;

	for (let offset = 0; offset <= span; offset++) {
		const atEnd = offset === span;
		const blackCount = atEnd ? 0 : countProjectionLine(axis, rect, offset, blackMask, imageWidth);
		const allowedBlackPixels = Math.floor(cross * options.gutterMaxBlackRatio);
		const isWhiteGutterLine = !atEnd && blackCount <= allowedBlackPixels;
		if (isWhiteGutterLine) {
			if (runStart < 0) {
				runStart = offset;
				runBlackTotal = 0;
			}
			runBlackTotal += blackCount;
			continue;
		}
		if (runStart >= 0) {
			best = pickBetterGutter(best, buildGutterCandidate(axis, rect, runStart, offset, runBlackTotal, cross, options));
			runStart = -1;
			runBlackTotal = 0;
		}
	}

	return best;
}

function buildGutterCandidate(
	axis: "x" | "y",
	rect: Rect,
	runStart: number,
	runEnd: number,
	runBlackTotal: number,
	cross: number,
	options: NormalizedOptions,
): GutterCandidate | null {
	const span = axis === "x" ? rect.w : rect.h;
	const minPanelSide = axis === "x" ? options.minPanelWidth : options.minPanelHeight;
	const runWidth = runEnd - runStart;
	if (runWidth < options.minGutterSize || runWidth > options.maxGutterSize) return null;
	const before = runStart;
	const after = span - runEnd;
	if (before < minPanelSide || after < minPanelSide) return null;

	const averageBlackRatio = runBlackTotal / Math.max(1, runWidth * cross);
	const balance = Math.min(before, after) / Math.max(before, after);
	const widthScore = runWidth / Math.max(1, span);
	const whiteness = 1 - averageBlackRatio / Math.max(options.gutterMaxBlackRatio, Number.EPSILON);
	const absoluteStart = (axis === "x" ? rect.x : rect.y) + runStart;
	const absoluteEnd = (axis === "x" ? rect.x : rect.y) + runEnd;

	// Gutters in framed manga are usually narrow, very white separators with real
	// panels on both sides; scoring this way avoids cutting through broad blank art.
	return {
		axis,
		start: absoluteStart,
		end: absoluteEnd,
		averageBlackRatio,
		score: widthScore * 3 + balance + whiteness,
	};
}

function pickBetterGutter(current: GutterCandidate | null, next: GutterCandidate | null): GutterCandidate | null {
	if (!next) return current;
	if (!current) return next;
	if (next.score !== current.score) return next.score > current.score ? next : current;
	if (next.averageBlackRatio !== current.averageBlackRatio) return next.averageBlackRatio < current.averageBlackRatio ? next : current;
	return next.start < current.start ? next : current;
}

function countProjectionLine(axis: "x" | "y", rect: Rect, offset: number, blackMask: Uint8Array, imageWidth: number): number {
	let count = 0;
	if (axis === "x") {
		const x = rect.x + offset;
		for (let y = rect.y; y < rect.y + rect.h; y++) count += blackMask[y * imageWidth + x];
		return count;
	}

	const y = rect.y + offset;
	const row = y * imageWidth;
	for (let x = rect.x; x < rect.x + rect.w; x++) count += blackMask[row + x];
	return count;
}

function trimToBlackBounds(rect: Rect, blackMask: Uint8Array, imageWidth: number): Rect | null {
	let minX = rect.x + rect.w;
	let minY = rect.y + rect.h;
	let maxX = rect.x - 1;
	let maxY = rect.y - 1;

	for (let y = rect.y; y < rect.y + rect.h; y++) {
		const row = y * imageWidth;
		for (let x = rect.x; x < rect.x + rect.w; x++) {
			if (blackMask[row + x] === 0) continue;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}

	if (maxX < minX || maxY < minY) return null;
	return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function isPanelSize(rect: Rect, options: NormalizedOptions): boolean {
	return rect.w >= options.minPanelWidth && rect.h >= options.minPanelHeight && rect.w * rect.h >= options.minPanelArea;
}

function hasPanelFrameEvidence(rect: Rect, blackMask: Uint8Array, imageWidth: number): boolean {
	const band = Math.max(1, Math.min(4, Math.round(Math.min(rect.w, rect.h) * 0.04)));
	const top = horizontalEdgeCoverage(rect, rect.y, rect.y + band, blackMask, imageWidth);
	const bottom = horizontalEdgeCoverage(rect, rect.y + rect.h - band, rect.y + rect.h, blackMask, imageWidth);
	const left = verticalEdgeCoverage(rect, rect.x, rect.x + band, blackMask, imageWidth);
	const right = verticalEdgeCoverage(rect, rect.x + rect.w - band, rect.x + rect.w, blackMask, imageWidth);
	const strongSides = [top, bottom, left, right].filter((coverage) => coverage >= 0.45).length;
	return strongSides >= 3;
}

function horizontalEdgeCoverage(rect: Rect, yStart: number, yEnd: number, blackMask: Uint8Array, imageWidth: number): number {
	let hits = 0;
	for (let x = rect.x; x < rect.x + rect.w; x++) {
		let hasBlack = false;
		for (let y = yStart; y < yEnd; y++) {
			if (blackMask[y * imageWidth + x] === 0) continue;
			hasBlack = true;
			break;
		}
		if (hasBlack) hits++;
	}
	return hits / Math.max(1, rect.w);
}

function verticalEdgeCoverage(rect: Rect, xStart: number, xEnd: number, blackMask: Uint8Array, imageWidth: number): number {
	let hits = 0;
	for (let y = rect.y; y < rect.y + rect.h; y++) {
		const row = y * imageWidth;
		let hasBlack = false;
		for (let x = xStart; x < xEnd; x++) {
			if (blackMask[row + x] === 0) continue;
			hasBlack = true;
			break;
		}
		if (hasBlack) hits++;
	}
	return hits / Math.max(1, rect.h);
}

function uniqueRects(rects: Rect[]): Rect[] {
	const seen = new Set<string>();
	const unique: Rect[] = [];
	for (const rect of rects) {
		const key = `${rect.x}:${rect.y}:${rect.w}:${rect.h}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(rect);
	}
	return unique;
}

function orderPanels(rects: Rect[], readingOrder: PanelReadingOrder): Rect[] {
	const rows: Array<{ top: number; bottom: number; rects: Rect[] }> = [];
	for (const rect of [...rects].sort((a, b) => a.y - b.y || a.x - b.x)) {
		const row = rows.find((candidate) => belongsToRow(rect, candidate.top, candidate.bottom));
		if (!row) {
			rows.push({ top: rect.y, bottom: rect.y + rect.h, rects: [rect] });
			continue;
		}
		row.top = Math.min(row.top, rect.y);
		row.bottom = Math.max(row.bottom, rect.y + rect.h);
		row.rects.push(rect);
	}

	return rows
		.sort((a, b) => a.top - b.top)
		.flatMap((row) =>
			row.rects.sort((a, b) => (readingOrder === "manga" ? b.x - a.x : a.x - b.x)),
		);
}

function belongsToRow(rect: Rect, rowTop: number, rowBottom: number): boolean {
	const overlap = Math.min(rect.y + rect.h, rowBottom) - Math.max(rect.y, rowTop);
	if (overlap <= 0) return false;
	const rowHeight = rowBottom - rowTop;
	return overlap / Math.min(rect.h, rowHeight) >= 0.45;
}

function clampNumber(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}

function clampInteger(value: number, min: number, max: number): number {
	return Math.round(clampNumber(value, min, max));
}

function valueAt(data: ArrayLike<number>, index: number, fallback: number): number {
	const value = data[index];
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
