export interface Point {
	x: number;
	y: number;
}

export interface Matrix2D {
	a: number;
	b: number;
	c: number;
	d: number;
	e: number;
	f: number;
}

export interface TransformBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type ResizeTransformHandle =
	| "top-left"
	| "top"
	| "top-right"
	| "right"
	| "bottom-right"
	| "bottom"
	| "bottom-left"
	| "left";

export type TransformHandle = ResizeTransformHandle | "rotate";

export interface TransformHandlePoint {
	handle: TransformHandle;
	point: Point;
}

export interface TransformHandleModelOptions {
	hitRadius?: number;
	rotationHandleOffset?: number;
}

export interface DragHandleOptions {
	keepAspect?: boolean;
	fromCenter?: boolean;
	minSize?: number;
}

export interface TransformHandleModel {
	bounds: TransformBounds;
	matrix: Matrix2D;
	handles: TransformHandlePoint[];
	hitTest: (point: Point) => TransformHandle | null;
	dragHandle: (handle: TransformHandle, delta: Point, options?: DragHandleOptions) => Matrix2D;
}

export interface ImageDataLike {
	width: number;
	height: number;
	data: ArrayLike<number>;
}

export interface TransformedImageData {
	width: number;
	height: number;
	data: Uint8ClampedArray;
}

const EPSILON = 1e-9;
const DEFAULT_HIT_RADIUS = 8;
const DEFAULT_ROTATION_HANDLE_OFFSET = 32;
const DEFAULT_MIN_SIZE = 1e-6;

const RESIZE_HANDLE_ORDER: ResizeTransformHandle[] = [
	"top-left",
	"top",
	"top-right",
	"right",
	"bottom-right",
	"bottom",
	"bottom-left",
	"left",
];

const HANDLE_AXES: Record<ResizeTransformHandle, { x: -1 | 0 | 1; y: -1 | 0 | 1 }> = {
	"top-left": { x: -1, y: -1 },
	top: { x: 0, y: -1 },
	"top-right": { x: 1, y: -1 },
	right: { x: 1, y: 0 },
	"bottom-right": { x: 1, y: 1 },
	bottom: { x: 0, y: 1 },
	"bottom-left": { x: -1, y: 1 },
	left: { x: -1, y: 0 },
};

export const IDENTITY_MATRIX: Matrix2D = Object.freeze({
	a: 1,
	b: 0,
	c: 0,
	d: 1,
	e: 0,
	f: 0,
});

export function identityMatrix(): Matrix2D {
	return { ...IDENTITY_MATRIX };
}

export function translateMatrix(tx: number, ty: number): Matrix2D {
	return {
		a: 1,
		b: 0,
		c: 0,
		d: 1,
		e: tx,
		f: ty,
	};
}

export function scaleMatrix(scaleX: number, scaleY = scaleX, origin?: Point): Matrix2D {
	const scale: Matrix2D = {
		a: scaleX,
		b: 0,
		c: 0,
		d: scaleY,
		e: 0,
		f: 0,
	};

	if (!origin) return scale;
	return multiplyMatrices(multiplyMatrices(translateMatrix(origin.x, origin.y), scale), translateMatrix(-origin.x, -origin.y));
}

export function rotateMatrix(angleDegrees: number, origin?: Point): Matrix2D {
	const angle = degreesToRadians(angleDegrees);
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const rotate: Matrix2D = {
		a: cos,
		b: sin,
		c: -sin,
		d: cos,
		e: 0,
		f: 0,
	};

	if (!origin) return rotate;
	return multiplyMatrices(multiplyMatrices(translateMatrix(origin.x, origin.y), rotate), translateMatrix(-origin.x, -origin.y));
}

export function skewMatrix(skewXDegrees = 0, skewYDegrees = 0, origin?: Point): Matrix2D {
	const skew: Matrix2D = {
		a: 1,
		b: Math.tan(degreesToRadians(skewYDegrees)),
		c: Math.tan(degreesToRadians(skewXDegrees)),
		d: 1,
		e: 0,
		f: 0,
	};

	if (!origin) return skew;
	return multiplyMatrices(multiplyMatrices(translateMatrix(origin.x, origin.y), skew), translateMatrix(-origin.x, -origin.y));
}

export function multiplyMatrices(left: Matrix2D, right: Matrix2D): Matrix2D {
	return {
		a: left.a * right.a + left.c * right.b,
		b: left.b * right.a + left.d * right.b,
		c: left.a * right.c + left.c * right.d,
		d: left.b * right.c + left.d * right.d,
		e: left.a * right.e + left.c * right.f + left.e,
		f: left.b * right.e + left.d * right.f + left.f,
	};
}

export function composeMatrix(...matrices: Matrix2D[]): Matrix2D {
	return matrices.reduce((matrix, next) => multiplyMatrices(matrix, next), identityMatrix());
}

export function invertMatrix(matrix: Matrix2D): Matrix2D {
	const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
	if (Math.abs(determinant) <= EPSILON) {
		throw new RangeError("Matrix is not invertible.");
	}

	return {
		a: matrix.d / determinant,
		b: -matrix.b / determinant,
		c: -matrix.c / determinant,
		d: matrix.a / determinant,
		e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
		f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant,
	};
}

export function applyMatrixToPoint(matrix: Matrix2D, point: Point): Point {
	return {
		x: matrix.a * point.x + matrix.c * point.y + matrix.e,
		y: matrix.b * point.x + matrix.d * point.y + matrix.f,
	};
}

export function getTransformHandles(
	bounds: TransformBounds,
	matrix: Matrix2D,
	options: Pick<TransformHandleModelOptions, "rotationHandleOffset"> = {},
): TransformHandlePoint[] {
	const rotationHandleOffset = options.rotationHandleOffset ?? DEFAULT_ROTATION_HANDLE_OFFSET;
	const handles: TransformHandlePoint[] = RESIZE_HANDLE_ORDER.map((handle) => ({
		handle,
		point: applyMatrixToPoint(matrix, getLocalHandlePoint(bounds, handle)),
	}));
	const top = handles.find((handle) => handle.handle === "top")?.point ?? applyMatrixToPoint(matrix, getBoundsCenter(bounds));
	const center = applyMatrixToPoint(matrix, getBoundsCenter(bounds));
	const outward = normalizeVector({ x: top.x - center.x, y: top.y - center.y }) ?? { x: 0, y: -1 };

	handles.push({
		handle: "rotate",
		point: {
			x: top.x + outward.x * rotationHandleOffset,
			y: top.y + outward.y * rotationHandleOffset,
		},
	});

	return handles;
}

export function hitTestTransformHandle(
	handles: TransformHandlePoint[],
	point: Point,
	hitRadius = DEFAULT_HIT_RADIUS,
): TransformHandle | null {
	const radius = Math.max(0, hitRadius);
	let best: { handle: TransformHandle; distanceSquared: number } | null = null;

	for (const handle of handles) {
		const distanceSquared = squaredDistance(point, handle.point);
		if (distanceSquared > radius * radius) continue;
		if (!best || distanceSquared < best.distanceSquared) {
			best = { handle: handle.handle, distanceSquared };
		}
	}

	return best?.handle ?? null;
}

export function createTransformHandleModel(
	bounds: TransformBounds,
	matrix: Matrix2D = IDENTITY_MATRIX,
	options: TransformHandleModelOptions = {},
): TransformHandleModel {
	const handles = getTransformHandles(bounds, matrix, options);
	const hitRadius = options.hitRadius ?? DEFAULT_HIT_RADIUS;

	return {
		bounds,
		matrix,
		handles,
		hitTest(point) {
			return hitTestTransformHandle(handles, point, hitRadius);
		},
		dragHandle(handle, delta, dragOptions) {
			return dragTransformHandle(bounds, matrix, handle, delta, dragOptions);
		},
	};
}

export function dragTransformHandle(
	bounds: TransformBounds,
	matrix: Matrix2D,
	handle: TransformHandle,
	delta: Point,
	options: DragHandleOptions = {},
): Matrix2D {
	if (handle === "rotate") return dragRotationHandle(bounds, matrix, delta);
	return dragResizeHandle(bounds, matrix, handle, delta, options);
}

export function snapRotation(angle: number, step = 15): number {
	if (step <= 0) return angle;
	return Math.round(angle / step) * step;
}

export function applyTransformToImageData(
	src: ImageDataLike,
	matrix: Matrix2D,
	outBounds: TransformBounds,
): TransformedImageData {
	const srcWidth = Math.trunc(src.width);
	const srcHeight = Math.trunc(src.height);
	const outWidth = Math.max(0, Math.round(outBounds.width));
	const outHeight = Math.max(0, Math.round(outBounds.height));
	const out = new Uint8ClampedArray(outWidth * outHeight * 4);

	if (outWidth === 0 || outHeight === 0) return { width: outWidth, height: outHeight, data: out };
	if (srcWidth <= 0 || srcHeight <= 0) return { width: outWidth, height: outHeight, data: out };
	if (src.data.length < srcWidth * srcHeight * 4) {
		throw new RangeError("Image data length must contain width * height * 4 RGBA entries.");
	}

	const inverse = invertMatrix(matrix);

	for (let y = 0; y < outHeight; y += 1) {
		for (let x = 0; x < outWidth; x += 1) {
			const srcPoint = applyMatrixToPoint(inverse, {
				x: outBounds.x + x,
				y: outBounds.y + y,
			});
			writeBilinearSample(src, srcWidth, srcHeight, srcPoint, out, (y * outWidth + x) * 4);
		}
	}

	return { width: outWidth, height: outHeight, data: out };
}

function dragResizeHandle(
	bounds: TransformBounds,
	matrix: Matrix2D,
	handle: ResizeTransformHandle,
	delta: Point,
	options: DragHandleOptions,
): Matrix2D {
	const axes = HANDLE_AXES[handle];
	const anchor = options.fromCenter ? getBoundsCenter(bounds) : getOppositeAnchor(bounds, handle);
	const handlePoint = getLocalHandlePoint(bounds, handle);
	const handleWorld = applyMatrixToPoint(matrix, handlePoint);
	const localEnd = applyMatrixToPoint(invertMatrix(matrix), {
		x: handleWorld.x + delta.x,
		y: handleWorld.y + delta.y,
	});

	let scaleX = axes.x === 0 ? 1 : safeScale((localEnd.x - anchor.x) / (handlePoint.x - anchor.x));
	let scaleY = axes.y === 0 ? 1 : safeScale((localEnd.y - anchor.y) / (handlePoint.y - anchor.y));

	if (options.keepAspect) {
		const aspectScale = pickAspectScale(scaleX, scaleY, axes);
		scaleX = aspectScale;
		scaleY = aspectScale;
	}

	const minSize = Math.max(0, options.minSize ?? DEFAULT_MIN_SIZE);
	const minScaleX = bounds.width === 0 ? 1 : minSize / Math.abs(bounds.width);
	const minScaleY = bounds.height === 0 ? 1 : minSize / Math.abs(bounds.height);
	scaleX = clampScale(scaleX, minScaleX);
	scaleY = clampScale(scaleY, minScaleY);

	// Scale in local coordinates so rotated/skewed selections resize along their own axes.
	const localScale: Matrix2D = {
		a: scaleX,
		b: 0,
		c: 0,
		d: scaleY,
		e: anchor.x * (1 - scaleX),
		f: anchor.y * (1 - scaleY),
	};

	return multiplyMatrices(matrix, localScale);
}

function dragRotationHandle(bounds: TransformBounds, matrix: Matrix2D, delta: Point): Matrix2D {
	const handles = getTransformHandles(bounds, matrix);
	const start = handles.find((handle) => handle.handle === "rotate")?.point;
	if (!start) return matrix;

	const center = applyMatrixToPoint(matrix, getBoundsCenter(bounds));
	const end = { x: start.x + delta.x, y: start.y + delta.y };
	const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
	const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
	if (!Number.isFinite(startAngle) || !Number.isFinite(endAngle)) return matrix;

	return multiplyMatrices(rotateMatrix(radiansToDegrees(endAngle - startAngle), center), matrix);
}

function getLocalHandlePoint(bounds: TransformBounds, handle: ResizeTransformHandle): Point {
	const left = bounds.x;
	const right = bounds.x + bounds.width;
	const centerX = bounds.x + bounds.width / 2;
	const top = bounds.y;
	const bottom = bounds.y + bounds.height;
	const centerY = bounds.y + bounds.height / 2;

	switch (handle) {
		case "top-left":
			return { x: left, y: top };
		case "top":
			return { x: centerX, y: top };
		case "top-right":
			return { x: right, y: top };
		case "right":
			return { x: right, y: centerY };
		case "bottom-right":
			return { x: right, y: bottom };
		case "bottom":
			return { x: centerX, y: bottom };
		case "bottom-left":
			return { x: left, y: bottom };
		case "left":
			return { x: left, y: centerY };
	}
}

function getOppositeAnchor(bounds: TransformBounds, handle: ResizeTransformHandle): Point {
	const axes = HANDLE_AXES[handle];
	const left = bounds.x;
	const right = bounds.x + bounds.width;
	const centerX = bounds.x + bounds.width / 2;
	const top = bounds.y;
	const bottom = bounds.y + bounds.height;
	const centerY = bounds.y + bounds.height / 2;

	return {
		x: axes.x === -1 ? right : axes.x === 1 ? left : centerX,
		y: axes.y === -1 ? bottom : axes.y === 1 ? top : centerY,
	};
}

function getBoundsCenter(bounds: TransformBounds): Point {
	return {
		x: bounds.x + bounds.width / 2,
		y: bounds.y + bounds.height / 2,
	};
}

function pickAspectScale(scaleX: number, scaleY: number, axes: { x: -1 | 0 | 1; y: -1 | 0 | 1 }): number {
	if (axes.x !== 0 && axes.y === 0) return scaleX;
	if (axes.y !== 0 && axes.x === 0) return scaleY;
	return Math.abs(scaleX - 1) >= Math.abs(scaleY - 1) ? scaleX : scaleY;
}

function safeScale(value: number): number {
	return Number.isFinite(value) ? value : 1;
}

function clampScale(value: number, minMagnitude: number): number {
	if (minMagnitude <= 0 || Math.abs(value) >= minMagnitude) return value;
	return value < 0 ? -minMagnitude : minMagnitude;
}

function writeBilinearSample(
	src: ImageDataLike,
	width: number,
	height: number,
	point: Point,
	out: Uint8ClampedArray,
	outOffset: number,
): void {
	const sampleX = normalizeSampleCoordinate(point.x, width);
	const sampleY = normalizeSampleCoordinate(point.y, height);
	if (sampleX === null || sampleY === null) {
		out[outOffset] = 0;
		out[outOffset + 1] = 0;
		out[outOffset + 2] = 0;
		out[outOffset + 3] = 0;
		return;
	}

	const x0 = Math.floor(sampleX);
	const y0 = Math.floor(sampleY);
	const x1 = Math.min(x0 + 1, width - 1);
	const y1 = Math.min(y0 + 1, height - 1);
	const tx = sampleX - x0;
	const ty = sampleY - y0;
	const topLeft = (y0 * width + x0) * 4;
	const topRight = (y0 * width + x1) * 4;
	const bottomLeft = (y1 * width + x0) * 4;
	const bottomRight = (y1 * width + x1) * 4;

	for (let channel = 0; channel < 4; channel += 1) {
		const top = lerp(src.data[topLeft + channel], src.data[topRight + channel], tx);
		const bottom = lerp(src.data[bottomLeft + channel], src.data[bottomRight + channel], tx);
		out[outOffset + channel] = lerp(top, bottom, ty);
	}
}

function normalizeSampleCoordinate(value: number, max: number): number | null {
	if (value < 0) return value > -EPSILON ? 0 : null;
	if (value >= max) return null;
	return value;
}

function normalizeVector(vector: Point): Point | null {
	const length = Math.hypot(vector.x, vector.y);
	if (length <= EPSILON) return null;
	return {
		x: vector.x / length,
		y: vector.y / length,
	};
}

function squaredDistance(a: Point, b: Point): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return dx * dx + dy * dy;
}

function lerp(start: number, end: number, amount: number): number {
	return start + (end - start) * amount;
}

function degreesToRadians(degrees: number): number {
	return degrees * (Math.PI / 180);
}

function radiansToDegrees(radians: number): number {
	return radians * (180 / Math.PI);
}
