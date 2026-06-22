export type RgbaBuffer = Uint8Array | Uint8ClampedArray;

export interface ImageDataLike<TData extends RgbaBuffer = RgbaBuffer> {
	data: TData;
	width: number;
	height: number;
}

export interface CurvePoint {
	x: number;
	y: number;
}

export type ChannelLut = Uint8Array | Uint8ClampedArray;

export interface RgbLuts {
	r: ChannelLut;
	g: ChannelLut;
	b: ChannelLut;
}

export interface AdjustmentApplyOptions {
	inPlace?: boolean;
}

export interface HslAdjustment {
	hue?: number;
	saturation?: number;
	lightness?: number;
}

const BYTE_MIN = 0;
const BYTE_MAX = 255;
const HUE_SCALE = 1536;

function finiteNumber(value: number, fallback: number): number {
	return Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function clampByte(value: number): number {
	return Math.round(clampNumber(finiteNumber(value, BYTE_MIN), BYTE_MIN, BYTE_MAX));
}

function clampParameter(value: number, min: number, max: number, fallback: number): number {
	return clampNumber(finiteNumber(value, fallback), min, max);
}

function cloneBuffer<TData extends RgbaBuffer>(data: TData): TData {
	return (data instanceof Uint8ClampedArray
		? new Uint8ClampedArray(data)
		: new Uint8Array(data)) as TData;
}

function outputImage<TImage extends ImageDataLike>(imageData: TImage, options: AdjustmentApplyOptions): TImage {
	if (options.inPlace) return imageData;
	return { ...imageData, data: cloneBuffer(imageData.data) } as TImage;
}

function assertRgbaDataLength(data: RgbaBuffer): void {
	if (data.length % 4 !== 0) {
		throw new Error("RGBA image data length must be a multiple of 4");
	}
}

function assertLut(lut: ChannelLut, name: string): void {
	if (lut.length !== 256) {
		throw new Error(`${name} LUT must contain exactly 256 entries`);
	}
}

function normalizeMod(value: number, modulus: number): number {
	const mod = value % modulus;
	return mod < 0 ? mod + modulus : mod;
}

export function buildIdentityLut(): Uint8Array {
	const lut = new Uint8Array(256);
	for (let i = 0; i < 256; i += 1) lut[i] = i;
	return lut;
}

export function buildLevelsLut(
	inBlack: number,
	inWhite: number,
	gamma: number,
	outBlack: number,
	outWhite: number,
): Uint8Array {
	const inputBlack = clampParameter(inBlack, BYTE_MIN, BYTE_MAX, BYTE_MIN);
	const inputWhite = clampParameter(inWhite, BYTE_MIN, BYTE_MAX, BYTE_MAX);
	const outputBlack = clampParameter(outBlack, BYTE_MIN, BYTE_MAX, BYTE_MIN);
	const outputWhite = clampParameter(outWhite, BYTE_MIN, BYTE_MAX, BYTE_MAX);
	const safeGamma = Math.max(0.01, finiteNumber(gamma, 1));
	const inputRange = Math.max(1, inputWhite - inputBlack);
	const outputRange = outputWhite - outputBlack;
	const lut = new Uint8Array(256);

	for (let i = 0; i < 256; i += 1) {
		const normalized = clampNumber((i - inputBlack) / inputRange, 0, 1);
		// Photoshop-style levels use gamma as a midtone control; 1/gamma keeps
		// gamma=1 exactly linear while allowing larger values to brighten mids.
		const corrected = Math.pow(normalized, 1 / safeGamma);
		lut[i] = clampByte(outputBlack + corrected * outputRange);
	}

	return lut;
}

function normalizeCurvePoints(points: readonly CurvePoint[]): CurvePoint[] {
	const sanitized = points
		.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
		.map((point) => ({ x: clampByte(point.x), y: clampByte(point.y) }))
		.sort((a, b) => a.x - b.x);

	if (sanitized.length === 0) return [{ x: 0, y: 0 }, { x: 255, y: 255 }];

	const unique: CurvePoint[] = [];
	for (const point of sanitized) {
		const previous = unique.at(-1);
		if (previous && previous.x === point.x) {
			previous.y = point.y;
		} else {
			unique.push({ ...point });
		}
	}

	if (unique[0].x !== 0) unique.unshift({ x: 0, y: 0 });
	if (unique[unique.length - 1].x !== 255) unique.push({ x: 255, y: 255 });
	return unique;
}

function buildMonotoneTangents(points: readonly CurvePoint[]): number[] {
	const count = points.length;
	const tangents = new Array<number>(count).fill(0);
	const widths = new Array<number>(count - 1);
	const slopes = new Array<number>(count - 1);

	for (let i = 0; i < count - 1; i += 1) {
		widths[i] = points[i + 1].x - points[i].x;
		slopes[i] = (points[i + 1].y - points[i].y) / widths[i];
	}

	tangents[0] = slopes[0];
	tangents[count - 1] = slopes[count - 2];

	for (let i = 1; i < count - 1; i += 1) {
		const before = slopes[i - 1];
		const after = slopes[i];
		if (before === 0 || after === 0 || Math.sign(before) !== Math.sign(after)) {
			tangents[i] = 0;
			continue;
		}
		const w1 = 2 * widths[i] + widths[i - 1];
		const w2 = widths[i] + 2 * widths[i - 1];
		tangents[i] = (w1 + w2) / (w1 / before + w2 / after);
	}

	for (let i = 0; i < count - 1; i += 1) {
		const slope = slopes[i];
		if (slope === 0) {
			tangents[i] = 0;
			tangents[i + 1] = 0;
			continue;
		}
		const a = tangents[i] / slope;
		const b = tangents[i + 1] / slope;
		if (a < 0) tangents[i] = 0;
		if (b < 0) tangents[i + 1] = 0;
		const length = Math.hypot(a, b);
		if (length > 3) {
			const scale = 3 / length;
			tangents[i] = scale * a * slope;
			tangents[i + 1] = scale * b * slope;
		}
	}

	return tangents;
}

export function buildCurveLut(points: readonly CurvePoint[]): Uint8Array {
	const normalized = normalizeCurvePoints(points);
	if (normalized.length === 2) {
		const [{ x: x0, y: y0 }, { x: x1, y: y1 }] = normalized;
		const lut = new Uint8Array(256);
		const width = Math.max(1, x1 - x0);
		for (let x = 0; x < 256; x += 1) {
			const t = clampNumber((x - x0) / width, 0, 1);
			lut[x] = clampByte(y0 + (y1 - y0) * t);
		}
		return lut;
	}

	const tangents = buildMonotoneTangents(normalized);
	const lut = new Uint8Array(256);
	let segment = 0;

	for (let x = 0; x < 256; x += 1) {
		while (segment < normalized.length - 2 && x > normalized[segment + 1].x) {
			segment += 1;
		}

		const left = normalized[segment];
		const right = normalized[segment + 1];
		const width = right.x - left.x;
		const t = width <= 0 ? 0 : (x - left.x) / width;
		const t2 = t * t;
		const t3 = t2 * t;
		const h00 = 2 * t3 - 3 * t2 + 1;
		const h10 = t3 - 2 * t2 + t;
		const h01 = -2 * t3 + 3 * t2;
		const h11 = t3 - t2;
		const interpolated =
			h00 * left.y +
			h10 * width * tangents[segment] +
			h01 * right.y +
			h11 * width * tangents[segment + 1];
		const low = Math.min(left.y, right.y);
		const high = Math.max(left.y, right.y);
		// The tangent limiter should already preserve shape, but the final segment
		// clamp is a cheap guard against floating-point edge overshoot in LUT builds.
		lut[x] = clampByte(clampNumber(interpolated, low, high));
	}

	return lut;
}

export function buildBrightnessContrastLut(brightness: number, contrast: number): Uint8Array {
	const safeBrightness = clampParameter(brightness, -100, 100, 0);
	const safeContrast = clampParameter(contrast, -100, 100, 0);
	const offset = (safeBrightness / 100) * BYTE_MAX;
	const factor = 1 + safeContrast / 100;
	const midpoint = 127.5;
	const lut = new Uint8Array(256);

	for (let i = 0; i < 256; i += 1) {
		lut[i] = clampByte((i - midpoint) * factor + midpoint + offset);
	}

	return lut;
}

export function applyLutRgb<TImage extends ImageDataLike>(
	imageData: TImage,
	lut: ChannelLut | RgbLuts,
	options: AdjustmentApplyOptions = {},
): TImage {
	assertRgbaDataLength(imageData.data);
	const target = outputImage(imageData, options);
	const data = target.data;
	const rLut = "r" in lut ? lut.r : lut;
	const gLut = "g" in lut ? lut.g : lut;
	const bLut = "b" in lut ? lut.b : lut;

	assertLut(rLut, "red");
	assertLut(gLut, "green");
	assertLut(bLut, "blue");

	for (let i = 0; i < data.length; i += 4) {
		data[i] = rLut[data[i]];
		data[i + 1] = gLut[data[i + 1]];
		data[i + 2] = bLut[data[i + 2]];
	}

	return target;
}

function hueToRgb(p: number, q: number, hue: number): number {
	const t = normalizeMod(hue, HUE_SCALE);
	if (t < 256) return p + ((q - p) * t) / 256;
	if (t < 768) return q;
	if (t < 1024) return p + ((q - p) * (1024 - t)) / 256;
	return p;
}

function applyHslPixel(data: RgbaBuffer, index: number, hueDelta: number, saturationDelta: number, lightnessDelta: number): void {
	const r = data[index];
	const g = data[index + 1];
	const b = data[index + 2];
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const chroma = max - min;
	let lightness2 = max + min;
	let saturation = 0;
	let hue = 0;

	if (chroma > 0) {
		const denominator = lightness2 <= 255 ? lightness2 : 510 - lightness2;
		saturation = denominator <= 0 ? 0 : Math.round((chroma * BYTE_MAX) / denominator);
		if (max === r) {
			hue = Math.round(((g - b) * 256) / chroma);
			if (g < b) hue += HUE_SCALE;
		} else if (max === g) {
			hue = Math.round(((b - r) * 256) / chroma) + 512;
		} else {
			hue = Math.round(((r - g) * 256) / chroma) + 1024;
		}
	}

	hue = normalizeMod(hue + hueDelta, HUE_SCALE);
	saturation = clampByte(saturation * (1 + saturationDelta / 100));
	lightness2 = lightnessDelta >= 0
		? lightness2 + (510 - lightness2) * (lightnessDelta / 100)
		: lightness2 * (1 + lightnessDelta / 100);
	lightness2 = clampNumber(lightness2, 0, 510);

	if (saturation === 0) {
		const gray = clampByte(lightness2 / 2);
		data[index] = gray;
		data[index + 1] = gray;
		data[index + 2] = gray;
		return;
	}

	// Keeping lightness as doubled byte precision preserves exact primary-color
	// rotations such as red +120deg -> green instead of introducing a +1 floor.
	const q = lightness2 < 255
		? (lightness2 * (255 + saturation)) / 510
		: lightness2 / 2 + saturation - (lightness2 * saturation) / 510;
	const p = lightness2 - q;

	data[index] = clampByte(hueToRgb(p, q, hue + 512));
	data[index + 1] = clampByte(hueToRgb(p, q, hue));
	data[index + 2] = clampByte(hueToRgb(p, q, hue - 512));
}

export function adjustHsl<TImage extends ImageDataLike>(
	imageData: TImage,
	adjustment: HslAdjustment,
	options: AdjustmentApplyOptions = {},
): TImage {
	assertRgbaDataLength(imageData.data);
	const hue = clampParameter(adjustment.hue ?? 0, -180, 180, 0);
	const saturation = clampParameter(adjustment.saturation ?? 0, -100, 100, 0);
	const lightness = clampParameter(adjustment.lightness ?? 0, -100, 100, 0);
	const hueDelta = Math.round((hue * HUE_SCALE) / 360);
	const target = outputImage(imageData, options);

	if (hueDelta === 0 && saturation === 0 && lightness === 0) return target;

	const data = target.data;
	for (let i = 0; i < data.length; i += 4) {
		applyHslPixel(data, i, hueDelta, saturation, lightness);
	}

	return target;
}
