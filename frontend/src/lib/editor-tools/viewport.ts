export interface Camera {
	scale: number;
	tx: number;
	ty: number;
}

export interface Point {
	x: number;
	y: number;
}

export interface Size {
	width: number;
	height: number;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ZoomLimits {
	min: number;
	max: number;
}

export interface PanOptions {
	imageSize: Size;
	viewportSize: Size;
	padding?: number;
	rubberBand?: number;
}

export interface PanBounds {
	minTx: number;
	maxTx: number;
	minTy: number;
	maxTy: number;
}

export type ZoomStepDirection = "in" | "out";

export interface ZoomStepOptions {
	limits?: Partial<ZoomLimits>;
	ladder?: readonly number[];
}

export const IDENTITY_CAMERA: Camera = { scale: 1, tx: 0, ty: 0 };
export const DEFAULT_ZOOM_LIMITS: ZoomLimits = { min: 0.05, max: 32 };
export const ZOOM_PRESET_LADDER = [0.25, 0.5, 0.66, 1, 2, 4] as const;
export const PIXEL_GRID_SCALE_THRESHOLD = 8;
export const DEFAULT_RUBBER_BAND = 72;

const EPSILON = 1e-9;

function finiteOr(value: number, fallback: number): number {
	return Number.isFinite(value) ? value : fallback;
}

function normalizePoint(point: Point): Point {
	return {
		x: finiteOr(point.x, 0),
		y: finiteOr(point.y, 0),
	};
}

function normalizePadding(padding: number | undefined): number {
	return Math.max(0, finiteOr(padding ?? 0, 0));
}

function normalizeRubberBand(rubberBand: number | undefined): number {
	return Math.max(0, finiteOr(rubberBand ?? DEFAULT_RUBBER_BAND, DEFAULT_RUBBER_BAND));
}

function normalizeScale(scale: number): number {
	return scale > 0 && Number.isFinite(scale) ? scale : IDENTITY_CAMERA.scale;
}

function normalizeCamera(camera: Camera): Camera {
	return {
		scale: normalizeScale(camera.scale),
		tx: finiteOr(camera.tx, IDENTITY_CAMERA.tx),
		ty: finiteOr(camera.ty, IDENTITY_CAMERA.ty),
	};
}

function hasUsableSize(size: Size): boolean {
	return size.width > 0
		&& size.height > 0
		&& Number.isFinite(size.width)
		&& Number.isFinite(size.height);
}

function normalizeZoomLimits(limits: Partial<ZoomLimits> | undefined): ZoomLimits {
	const rawMin = limits?.min ?? DEFAULT_ZOOM_LIMITS.min;
	const rawMax = limits?.max ?? DEFAULT_ZOOM_LIMITS.max;
	const min = rawMin > 0 && Number.isFinite(rawMin) ? rawMin : DEFAULT_ZOOM_LIMITS.min;
	const max = rawMax > 0 && Number.isFinite(rawMax) ? rawMax : DEFAULT_ZOOM_LIMITS.max;

	return {
		min: Math.min(min, max),
		max: Math.max(min, max),
	};
}

export function clampScale(scale: number, limits: Partial<ZoomLimits> = DEFAULT_ZOOM_LIMITS): number {
	const normalizedLimits = normalizeZoomLimits(limits);
	const normalizedScale = normalizeScale(scale);
	return Math.max(normalizedLimits.min, Math.min(normalizedLimits.max, normalizedScale));
}

export function screenToImage(camera: Camera, screenPoint: Point): Point {
	const normalizedCamera = normalizeCamera(camera);
	const point = normalizePoint(screenPoint);

	return {
		x: (point.x - normalizedCamera.tx) / normalizedCamera.scale,
		y: (point.y - normalizedCamera.ty) / normalizedCamera.scale,
	};
}

export function imageToScreen(camera: Camera, imagePoint: Point): Point {
	const normalizedCamera = normalizeCamera(camera);
	const point = normalizePoint(imagePoint);

	return {
		x: point.x * normalizedCamera.scale + normalizedCamera.tx,
		y: point.y * normalizedCamera.scale + normalizedCamera.ty,
	};
}

function rectFromCorners(a: Point, b: Point): Rect {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);

	return {
		x,
		y,
		width: Math.max(a.x, b.x) - x,
		height: Math.max(a.y, b.y) - y,
	};
}

export function screenRectToImage(camera: Camera, screenRect: Rect): Rect {
	const topLeft = screenToImage(camera, { x: screenRect.x, y: screenRect.y });
	const bottomRight = screenToImage(camera, {
		x: screenRect.x + finiteOr(screenRect.width, 0),
		y: screenRect.y + finiteOr(screenRect.height, 0),
	});

	return rectFromCorners(topLeft, bottomRight);
}

export function imageRectToScreen(camera: Camera, imageRect: Rect): Rect {
	const topLeft = imageToScreen(camera, { x: imageRect.x, y: imageRect.y });
	const bottomRight = imageToScreen(camera, {
		x: imageRect.x + finiteOr(imageRect.width, 0),
		y: imageRect.y + finiteOr(imageRect.height, 0),
	});

	return rectFromCorners(topLeft, bottomRight);
}

export function setZoomAt(
	camera: Camera,
	screenPoint: Point,
	nextScale: number,
	limits: Partial<ZoomLimits> = DEFAULT_ZOOM_LIMITS,
): Camera {
	const normalizedCamera = normalizeCamera(camera);
	const point = normalizePoint(screenPoint);
	const scale = clampScale(nextScale, limits);
	const scaleRatio = scale / normalizedCamera.scale;

	return {
		scale,
		tx: point.x - (point.x - normalizedCamera.tx) * scaleRatio,
		ty: point.y - (point.y - normalizedCamera.ty) * scaleRatio,
	};
}

export function zoomAt(
	camera: Camera,
	screenPoint: Point,
	factor: number,
	limits: Partial<ZoomLimits> = DEFAULT_ZOOM_LIMITS,
): Camera {
	const normalizedCamera = normalizeCamera(camera);
	const safeFactor = factor > 0 && Number.isFinite(factor) ? factor : 1;
	return setZoomAt(normalizedCamera, screenPoint, normalizedCamera.scale * safeFactor, limits);
}

export function fit(
	imageSize: Size,
	viewportSize: Size,
	padding = 0,
	limits?: Partial<ZoomLimits>,
): Camera {
	if (!hasUsableSize(imageSize) || !hasUsableSize(viewportSize)) return { ...IDENTITY_CAMERA };

	const normalizedPadding = normalizePadding(padding);
	const availableWidth = Math.max(1, viewportSize.width - normalizedPadding * 2);
	const availableHeight = Math.max(1, viewportSize.height - normalizedPadding * 2);
	const rawScale = Math.min(availableWidth / imageSize.width, availableHeight / imageSize.height);
	const scale = limits ? clampScale(rawScale, limits) : normalizeScale(rawScale);

	return {
		scale,
		tx: (viewportSize.width - imageSize.width * scale) / 2,
		ty: (viewportSize.height - imageSize.height * scale) / 2,
	};
}

export function fillWidth(
	imageSize: Size,
	viewportSize: Size,
	padding = 0,
	limits?: Partial<ZoomLimits>,
): Camera {
	if (!hasUsableSize(imageSize) || !hasUsableSize(viewportSize)) return { ...IDENTITY_CAMERA };

	const normalizedPadding = normalizePadding(padding);
	const availableWidth = Math.max(1, viewportSize.width - normalizedPadding * 2);
	const rawScale = availableWidth / imageSize.width;
	const scale = limits ? clampScale(rawScale, limits) : normalizeScale(rawScale);

	return {
		scale,
		tx: (viewportSize.width - imageSize.width * scale) / 2,
		// Width-fill is used for vertical page reading, so keep the page top discoverable.
		ty: normalizedPadding,
	};
}

function getAxisBounds(
	contentScreenSize: number,
	viewportScreenSize: number,
	padding: number,
	rubberBand: number,
): { min: number; max: number } {
	const innerSize = Math.max(0, viewportScreenSize - padding * 2);

	if (contentScreenSize <= innerSize) {
		const centered = (viewportScreenSize - contentScreenSize) / 2;
		return {
			min: centered - rubberBand,
			max: centered + rubberBand,
		};
	}

	return {
		min: viewportScreenSize - padding - contentScreenSize - rubberBand,
		max: padding + rubberBand,
	};
}

export function getPanBounds(camera: Camera, options: PanOptions): PanBounds {
	const normalizedCamera = normalizeCamera(camera);
	const padding = normalizePadding(options.padding);
	const rubberBand = normalizeRubberBand(options.rubberBand);

	if (!hasUsableSize(options.imageSize) || !hasUsableSize(options.viewportSize)) {
		return {
			minTx: normalizedCamera.tx,
			maxTx: normalizedCamera.tx,
			minTy: normalizedCamera.ty,
			maxTy: normalizedCamera.ty,
		};
	}

	const xBounds = getAxisBounds(
		options.imageSize.width * normalizedCamera.scale,
		options.viewportSize.width,
		padding,
		rubberBand,
	);
	const yBounds = getAxisBounds(
		options.imageSize.height * normalizedCamera.scale,
		options.viewportSize.height,
		padding,
		rubberBand,
	);

	return {
		minTx: xBounds.min,
		maxTx: xBounds.max,
		minTy: yBounds.min,
		maxTy: yBounds.max,
	};
}

function clampTranslation(camera: Camera, bounds: PanBounds): Camera {
	return {
		scale: camera.scale,
		tx: Math.max(bounds.minTx, Math.min(bounds.maxTx, camera.tx)),
		ty: Math.max(bounds.minTy, Math.min(bounds.maxTy, camera.ty)),
	};
}

export function pan(camera: Camera, delta: Point, options: PanOptions): Camera {
	const normalizedCamera = normalizeCamera(camera);
	const point = normalizePoint(delta);
	const nextCamera = {
		...normalizedCamera,
		tx: normalizedCamera.tx + point.x,
		ty: normalizedCamera.ty + point.y,
	};

	// Rubber-band bounds intentionally allow temporary overscroll; settlePan()
	// supplies the snap-back target after the gesture ends.
	return clampTranslation(nextCamera, getPanBounds(nextCamera, options));
}

export function settlePan(camera: Camera, options: Omit<PanOptions, "rubberBand">): Camera {
	const normalizedCamera = normalizeCamera(camera);
	return clampTranslation(normalizedCamera, getPanBounds(normalizedCamera, {
		...options,
		rubberBand: 0,
	}));
}

function normalizeLadder(
	ladder: readonly number[] | undefined,
	limits: ZoomLimits,
): number[] {
	const values = (ladder ?? ZOOM_PRESET_LADDER)
		.filter((value) => value > 0 && Number.isFinite(value))
		.map((value) => clampScale(value, limits));
	const deduped = Array.from(new Set(values)).sort((a, b) => a - b);
	return deduped.length > 0 ? deduped : [clampScale(1, limits)];
}

export function nextZoomScale(
	currentScale: number,
	direction: ZoomStepDirection,
	options: ZoomStepOptions = {},
): number {
	const limits = normalizeZoomLimits(options.limits);
	const scale = clampScale(currentScale, limits);
	const ladder = normalizeLadder(options.ladder, limits);

	if (direction === "in") {
		const nextPreset = ladder.find((preset) => preset > scale + EPSILON);
		return nextPreset ?? clampScale(scale * 2, limits);
	}

	const nextPreset = [...ladder].reverse().find((preset) => preset < scale - EPSILON);
	return nextPreset ?? clampScale(scale / 2, limits);
}

export function zoomToNextStep(
	camera: Camera,
	screenPoint: Point,
	direction: ZoomStepDirection,
	options: ZoomStepOptions = {},
): Camera {
	return setZoomAt(
		camera,
		screenPoint,
		nextZoomScale(camera.scale, direction, options),
		options.limits,
	);
}

export function shouldShowPixelGrid(cameraOrScale: Camera | number, threshold = PIXEL_GRID_SCALE_THRESHOLD): boolean {
	const scale = typeof cameraOrScale === "number" ? cameraOrScale : cameraOrScale.scale;
	const normalizedThreshold = Math.max(0, finiteOr(threshold, PIXEL_GRID_SCALE_THRESHOLD));
	return Number.isFinite(scale) && scale > normalizedThreshold;
}
