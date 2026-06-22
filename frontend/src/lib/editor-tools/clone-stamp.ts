export interface ImageDataLike {
	readonly width: number;
	readonly height: number;
	readonly data: Uint8ClampedArray;
}

export interface CloneStampPoint {
	readonly x: number;
	readonly y: number;
}

export interface CloneStampBrush {
	/** Diameter in image pixels. */
	readonly size: number;
	/** 0 = fully feathered edge, 1 = hard disc. */
	readonly hardness: number;
	/** Applied on top of source alpha and brush falloff. */
	readonly opacity: number;
}

export interface PixelBounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface StampResult {
	readonly pixelsWritten: number;
	readonly bounds: PixelBounds | null;
}

export interface StrokeStampOptions {
	/**
	 * Distance between interpolated dabs as a fraction of brush size.
	 * Values above 1 are treated as whole percentages, so 25 means 25%.
	 */
	readonly spacingPercent?: number;
}

export interface StrokeStampResult extends StampResult {
	readonly dabs: number;
}

export type CloneStampMode = "aligned" | "non-aligned";

export interface CloneStampStrokeState {
	readonly targetStart: CloneStampPoint;
	readonly sourceStart: CloneStampPoint;
}

export interface CloneStampState {
	mode: CloneStampMode;
	source: CloneStampPoint | null;
	/** Stored as target - source so aligned strokes can keep the same clone relation. */
	alignedOffset: CloneStampPoint | null;
	stroke: CloneStampStrokeState | null;
}

interface NormalizedBrush {
	readonly size: number;
	readonly radius: number;
	readonly hardness: number;
	readonly opacity: number;
}

const CHANNELS_PER_PIXEL = 4;
const DEFAULT_SPACING_PERCENT = 0.25;

export function createCloneStampState(mode: CloneStampMode = "aligned"): CloneStampState {
	return {
		mode,
		source: null,
		alignedOffset: null,
		stroke: null,
	};
}

export function setCloneStampSource(state: CloneStampState, source: CloneStampPoint): CloneStampState {
	assertPoint(source, "source");
	state.source = clonePoint(source);
	state.alignedOffset = null;
	state.stroke = null;
	return state;
}

export function beginCloneStampStroke(
	state: CloneStampState,
	targetStart: CloneStampPoint,
): CloneStampStrokeState | null {
	assertPoint(targetStart, "targetStart");
	if (!state.source) return null;

	let sourceStart: CloneStampPoint;
	if (state.mode === "aligned") {
		if (!state.alignedOffset) {
			state.alignedOffset = {
				x: targetStart.x - state.source.x,
				y: targetStart.y - state.source.y,
			};
		}
		sourceStart = {
			x: targetStart.x - state.alignedOffset.x,
			y: targetStart.y - state.alignedOffset.y,
		};
	} else if (state.mode === "non-aligned") {
		// Non-aligned clone stamp always restarts from the sampled source per stroke.
		sourceStart = clonePoint(state.source);
	} else {
		throw new RangeError(`Unsupported clone stamp mode: ${String(state.mode)}`);
	}

	state.stroke = {
		targetStart: clonePoint(targetStart),
		sourceStart,
	};
	return cloneStrokeState(state.stroke);
}

export function sourcePointForCloneStampTarget(
	state: CloneStampState,
	target: CloneStampPoint,
): CloneStampPoint | null {
	assertPoint(target, "target");
	if (!state.stroke) return null;
	return {
		x: state.stroke.sourceStart.x + (target.x - state.stroke.targetStart.x),
		y: state.stroke.sourceStart.y + (target.y - state.stroke.targetStart.y),
	};
}

export function endCloneStampStroke(state: CloneStampState): CloneStampState {
	state.stroke = null;
	return state;
}

export function stampCloneStroke(
	target: ImageDataLike,
	source: ImageDataLike,
	state: CloneStampState,
	points: readonly CloneStampPoint[],
	brush: CloneStampBrush,
	options: StrokeStampOptions = {},
): StrokeStampResult {
	if (points.length === 0) return emptyStrokeResult();
	const stroke = beginCloneStampStroke(state, points[0]);
	if (!stroke) return emptyStrokeResult();
	try {
		return stampStroke(target, source, stroke.sourceStart, points, brush, options);
	} finally {
		endCloneStampStroke(state);
	}
}

export function stampStroke(
	target: ImageDataLike,
	source: ImageDataLike,
	sourceStart: CloneStampPoint,
	points: readonly CloneStampPoint[],
	brush: CloneStampBrush,
	options: StrokeStampOptions = {},
): StrokeStampResult {
	assertImageDataLike(target, "target");
	assertImageDataLike(source, "source");
	assertPoint(sourceStart, "sourceStart");
	if (points.length === 0) return emptyStrokeResult();

	const normalized = normalizeBrush(brush);
	if (normalized.size <= 0 || normalized.opacity <= 0) return emptyStrokeResult();

	const stableSource = stableSourceForStroke(target, source);
	const spacing = strokeSpacing(normalized.size, options.spacingPercent);
	const firstTarget = points[0];
	assertPoint(firstTarget, "points[0]");

	let dabs = 0;
	let pixelsWritten = 0;
	let bounds: PixelBounds | null = null;

	const applyDab = (targetPoint: CloneStampPoint): void => {
		const sourcePoint = {
			x: sourceStart.x + (targetPoint.x - firstTarget.x),
			y: sourceStart.y + (targetPoint.y - firstTarget.y),
		};
		const result = stampDabInternal(
			target,
			stableSource,
			sourcePoint.x,
			sourcePoint.y,
			targetPoint.x,
			targetPoint.y,
			normalized,
		);
		dabs += 1;
		pixelsWritten += result.pixelsWritten;
		bounds = unionBounds(bounds, result.bounds);
	};

	applyDab(firstTarget);
	for (let index = 1; index < points.length; index += 1) {
		const from = points[index - 1];
		const to = points[index];
		assertPoint(to, `points[${index}]`);
		const dx = to.x - from.x;
		const dy = to.y - from.y;
		const distance = Math.hypot(dx, dy);
		if (distance === 0) continue;
		const steps = Math.max(1, Math.ceil(distance / spacing));
		for (let step = 1; step <= steps; step += 1) {
			const t = step / steps;
			applyDab({
				x: from.x + dx * t,
				y: from.y + dy * t,
			});
		}
	}

	return { dabs, pixelsWritten, bounds };
}

export function stampDab(
	target: ImageDataLike,
	source: ImageDataLike,
	srcX: number,
	srcY: number,
	dstX: number,
	dstY: number,
	brush: CloneStampBrush,
): StampResult {
	assertImageDataLike(target, "target");
	assertImageDataLike(source, "source");
	assertFinite(srcX, "srcX");
	assertFinite(srcY, "srcY");
	assertFinite(dstX, "dstX");
	assertFinite(dstY, "dstY");

	const normalized = normalizeBrush(brush);
	if (normalized.size <= 0 || normalized.opacity <= 0) return emptyStampResult();

	// A clone stamp must sample from the pre-dab pixels, even when caller passes
	// the same ImageDataLike as source and target for quick local edits.
	const stableSource = stableSourceForStroke(target, source);
	return stampDabInternal(target, stableSource, srcX, srcY, dstX, dstY, normalized);
}

function stampDabInternal(
	target: ImageDataLike,
	source: ImageDataLike,
	srcX: number,
	srcY: number,
	dstX: number,
	dstY: number,
	brush: NormalizedBrush,
): StampResult {
	const radius = brush.radius;
	if (radius <= 0) return emptyStampResult();

	const dstMinX = Math.max(0, Math.floor(dstX - radius));
	const dstMinY = Math.max(0, Math.floor(dstY - radius));
	const dstMaxX = Math.min(target.width - 1, Math.ceil(dstX + radius));
	const dstMaxY = Math.min(target.height - 1, Math.ceil(dstY + radius));
	if (dstMaxX < dstMinX || dstMaxY < dstMinY) return emptyStampResult();

	let pixelsWritten = 0;
	let minX = target.width;
	let minY = target.height;
	let maxX = -1;
	let maxY = -1;

	for (let y = dstMinY; y <= dstMaxY; y += 1) {
		for (let x = dstMinX; x <= dstMaxX; x += 1) {
			const distance = Math.hypot(x - dstX, y - dstY);
			const coverage = brushCoverage(distance, radius, brush.hardness) * brush.opacity;
			if (coverage <= 0) continue;

			const sourceX = Math.round(srcX + (x - dstX));
			const sourceY = Math.round(srcY + (y - dstY));
			if (sourceX < 0 || sourceY < 0 || sourceX >= source.width || sourceY >= source.height) continue;

			const targetOffset = (y * target.width + x) * CHANNELS_PER_PIXEL;
			const sourceOffset = (sourceY * source.width + sourceX) * CHANNELS_PER_PIXEL;
			if (alphaCompositePixel(target.data, targetOffset, source.data, sourceOffset, coverage)) {
				pixelsWritten += 1;
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}

	if (maxX < 0) return emptyStampResult();
	return {
		pixelsWritten,
		bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
	};
}

function alphaCompositePixel(
	target: Uint8ClampedArray,
	targetOffset: number,
	source: Uint8ClampedArray,
	sourceOffset: number,
	coverage: number,
): boolean {
	const sourceAlpha = (source[sourceOffset + 3] / 255) * coverage;
	if (sourceAlpha <= 0) return false;

	const targetAlpha = target[targetOffset + 3] / 255;
	const retainedTargetAlpha = targetAlpha * (1 - sourceAlpha);
	const outAlpha = sourceAlpha + retainedTargetAlpha;
	if (outAlpha <= 0) {
		target[targetOffset] = 0;
		target[targetOffset + 1] = 0;
		target[targetOffset + 2] = 0;
		target[targetOffset + 3] = 0;
		return true;
	}

	target[targetOffset] = roundByte(
		(source[sourceOffset] * sourceAlpha + target[targetOffset] * retainedTargetAlpha) / outAlpha,
	);
	target[targetOffset + 1] = roundByte(
		(source[sourceOffset + 1] * sourceAlpha + target[targetOffset + 1] * retainedTargetAlpha) / outAlpha,
	);
	target[targetOffset + 2] = roundByte(
		(source[sourceOffset + 2] * sourceAlpha + target[targetOffset + 2] * retainedTargetAlpha) / outAlpha,
	);
	target[targetOffset + 3] = roundByte(outAlpha * 255);
	return true;
}

function brushCoverage(distance: number, radius: number, hardness: number): number {
	if (distance > radius) return 0;
	if (distance === 0) return 1;
	const innerRadius = radius * hardness;
	if (distance <= innerRadius || radius <= innerRadius) return 1;
	return 1 - (distance - innerRadius) / (radius - innerRadius);
}

function normalizeBrush(brush: CloneStampBrush): NormalizedBrush {
	assertFinite(brush.size, "brush.size");
	assertFinite(brush.hardness, "brush.hardness");
	assertFinite(brush.opacity, "brush.opacity");
	const size = Math.max(0, brush.size);
	return {
		size,
		radius: size / 2,
		hardness: clamp01(brush.hardness),
		opacity: clamp01(brush.opacity),
	};
}

function strokeSpacing(size: number, spacingPercent: number | undefined): number {
	if (spacingPercent !== undefined) {
		assertFinite(spacingPercent, "options.spacingPercent");
		if (spacingPercent <= 0) throw new RangeError("options.spacingPercent must be greater than 0");
	}
	const rawPercent = spacingPercent ?? DEFAULT_SPACING_PERCENT;
	const fraction = rawPercent > 1 ? rawPercent / 100 : rawPercent;
	return Math.max(0.01, size * fraction);
}

function stableSourceForStroke(target: ImageDataLike, source: ImageDataLike): ImageDataLike {
	if (target.data !== source.data) return source;
	return {
		width: source.width,
		height: source.height,
		data: new Uint8ClampedArray(source.data),
	};
}

function assertImageDataLike(image: ImageDataLike, label: string): void {
	if (!Number.isInteger(image.width) || image.width <= 0) {
		throw new RangeError(`${label}.width must be a positive integer`);
	}
	if (!Number.isInteger(image.height) || image.height <= 0) {
		throw new RangeError(`${label}.height must be a positive integer`);
	}
	const expectedLength = image.width * image.height * CHANNELS_PER_PIXEL;
	if (!(image.data instanceof Uint8ClampedArray) || image.data.length < expectedLength) {
		throw new RangeError(`${label}.data must contain width * height * 4 RGBA bytes`);
	}
}

function assertPoint(point: CloneStampPoint, label: string): void {
	assertFinite(point.x, `${label}.x`);
	assertFinite(point.y, `${label}.y`);
}

function assertFinite(value: number, label: string): void {
	if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
}

function clonePoint(point: CloneStampPoint): CloneStampPoint {
	return { x: point.x, y: point.y };
}

function cloneStrokeState(stroke: CloneStampStrokeState): CloneStampStrokeState {
	return {
		targetStart: clonePoint(stroke.targetStart),
		sourceStart: clonePoint(stroke.sourceStart),
	};
}

function unionBounds(a: PixelBounds | null, b: PixelBounds | null): PixelBounds | null {
	if (!a) return b ? { ...b } : null;
	if (!b) return a;
	const x0 = Math.min(a.x, b.x);
	const y0 = Math.min(a.y, b.y);
	const x1 = Math.max(a.x + a.width, b.x + b.width);
	const y1 = Math.max(a.y + a.height, b.y + b.height);
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function emptyStampResult(): StampResult {
	return { pixelsWritten: 0, bounds: null };
}

function emptyStrokeResult(): StrokeStampResult {
	return { dabs: 0, pixelsWritten: 0, bounds: null };
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function roundByte(value: number): number {
	return Math.min(255, Math.max(0, Math.round(value)));
}
