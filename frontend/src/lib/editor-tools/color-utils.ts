export type HexColor = `#${string}`;

export interface RgbColor {
	r: number;
	g: number;
	b: number;
}

export interface HslColor {
	/** Hue in degrees, 0..360. 360 is accepted and normalized to 0. */
	h: number;
	/** Saturation, 0..1. */
	s: number;
	/** Lightness, 0..1. */
	l: number;
}

export interface HsvColor {
	/** Hue in degrees, 0..360. 360 is accepted and normalized to 0. */
	h: number;
	/** Saturation, 0..1. */
	s: number;
	/** Value, 0..1. */
	v: number;
}

export interface ImageDataLike {
	data: ArrayLike<number>;
	width: number;
	height: number;
}

export interface EyedropperOptions {
	sampleSize?: 1 | 3 | 5;
}

export interface PaletteColor {
	name: string;
	hex: HexColor;
}

export interface ColorPair {
	fg: HexColor;
	bg: HexColor;
}

export type WcagLevel = "AA" | "AAA";

export interface ReadabilityOptions {
	level?: WcagLevel;
	largeText?: boolean;
}

export const RECENT_COLORS_LIMIT = 16;
export const DEFAULT_FOREGROUND: HexColor = "#000000";
export const DEFAULT_BACKGROUND: HexColor = "#ffffff";

export const MANGA_DEFAULT_PALETTE = [
	{ name: "Paper white", hex: "#ffffff" },
	{ name: "Ink black", hex: "#000000" },
	{ name: "Screen gray 25", hex: "#404040" },
	{ name: "Screen gray 50", hex: "#808080" },
	{ name: "Screen gray 75", hex: "#c0c0c0" },
	{ name: "Ink red", hex: "#c1121f" },
] as const satisfies readonly PaletteColor[];

export const DEFAULT_MANGA_PALETTE = MANGA_DEFAULT_PALETTE;

const SHORT_HEX_RE = /^#[0-9a-fA-F]{3}$/;
const LONG_HEX_RE = /^#[0-9a-fA-F]{6}$/;

function assertFiniteNumber(value: number, label: string): void {
	if (!Number.isFinite(value)) {
		throw new TypeError(`${label} must be a finite number`);
	}
}

function assertInteger(value: number, label: string): void {
	assertFiniteNumber(value, label);
	if (!Number.isInteger(value)) {
		throw new RangeError(`${label} must be an integer`);
	}
}

function assertUnit(value: number, label: string): void {
	assertFiniteNumber(value, label);
	if (value < 0 || value > 1) {
		throw new RangeError(`${label} must be between 0 and 1`);
	}
}

function assertHue(value: number, label: string): number {
	assertFiniteNumber(value, label);
	if (value < 0 || value > 360) {
		throw new RangeError(`${label} must be between 0 and 360`);
	}
	return value === 360 ? 0 : value;
}

function assertDimension(value: number, label: string): void {
	assertInteger(value, label);
	if (value <= 0) {
		throw new RangeError(`${label} must be greater than 0`);
	}
}

function assertRgbChannel(value: number, label: string): number {
	assertInteger(value, label);
	if (value < 0 || value > 255) {
		throw new RangeError(`${label} must be between 0 and 255`);
	}
	return value;
}

function normalizeRgb(rgb: RgbColor): RgbColor {
	return {
		r: assertRgbChannel(rgb.r, "r"),
		g: assertRgbChannel(rgb.g, "g"),
		b: assertRgbChannel(rgb.b, "b"),
	};
}

function normalizeHsl(hsl: HslColor): HslColor {
	const h = assertHue(hsl.h, "h");
	assertUnit(hsl.s, "s");
	assertUnit(hsl.l, "l");
	return {
		h,
		s: hsl.s,
		l: hsl.l,
	};
}

function normalizeHsv(hsv: HsvColor): HsvColor {
	const h = assertHue(hsv.h, "h");
	assertUnit(hsv.s, "s");
	assertUnit(hsv.v, "v");
	return {
		h,
		s: hsv.s,
		v: hsv.v,
	};
}

function normalizeChannel(value: number): number {
	return Math.min(255, Math.max(0, Math.round(value)));
}

function channelToHex(value: number): string {
	return value.toString(16).padStart(2, "0");
}

function hueToRgb(p: number, q: number, t: number): number {
	let hue = t;
	if (hue < 0) hue += 1;
	if (hue > 1) hue -= 1;
	if (hue < 1 / 6) return p + (q - p) * 6 * hue;
	if (hue < 1 / 2) return q;
	if (hue < 2 / 3) return p + (q - p) * (2 / 3 - hue) * 6;
	return p;
}

function parseRgbArgs(rgbOrR: RgbColor | number, g?: number, b?: number): RgbColor {
	if (typeof rgbOrR === "number") {
		if (g === undefined || b === undefined) {
			throw new TypeError("g and b are required when r is passed as a number");
		}
		return normalizeRgb({ r: rgbOrR, g, b });
	}
	return normalizeRgb(rgbOrR);
}

function toRgbColor(color: HexColor | string | RgbColor): RgbColor {
	return typeof color === "string" ? hexToRgb(color) : normalizeRgb(color);
}

function pixelComponent(data: ArrayLike<number>, index: number): number {
	const value = data[index];
	if (!Number.isFinite(value) || value < 0 || value > 255) {
		throw new RangeError(`pixel component at ${index} must be between 0 and 255`);
	}
	return value;
}

export function isValidHex(value: string): boolean {
	return SHORT_HEX_RE.test(value) || LONG_HEX_RE.test(value);
}

export function normalizeHex(value: string): HexColor {
	if (typeof value !== "string" || !isValidHex(value)) {
		throw new TypeError("hex color must be #rgb or #rrggbb");
	}
	const lower = value.toLowerCase();
	if (lower.length === 4) {
		const r = lower.charAt(1);
		const g = lower.charAt(2);
		const b = lower.charAt(3);
		return `#${r}${r}${g}${g}${b}${b}`;
	}
	return lower as HexColor;
}

export function hexToRgb(hex: string): RgbColor {
	const normalized = normalizeHex(hex);
	return {
		r: Number.parseInt(normalized.slice(1, 3), 16),
		g: Number.parseInt(normalized.slice(3, 5), 16),
		b: Number.parseInt(normalized.slice(5, 7), 16),
	};
}

export function rgbToHex(rgb: RgbColor): HexColor;
export function rgbToHex(r: number, g: number, b: number): HexColor;
export function rgbToHex(rgbOrR: RgbColor | number, g?: number, b?: number): HexColor {
	const rgb = parseRgbArgs(rgbOrR, g, b);
	return `#${channelToHex(rgb.r)}${channelToHex(rgb.g)}${channelToHex(rgb.b)}`;
}

export function rgbToHsl(rgb: RgbColor): HslColor;
export function rgbToHsl(r: number, g: number, b: number): HslColor;
export function rgbToHsl(rgbOrR: RgbColor | number, g?: number, b?: number): HslColor {
	const { r, g: green, b: blue } = parseRgbArgs(rgbOrR, g, b);
	const rn = r / 255;
	const gn = green / 255;
	const bn = blue / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;
	const delta = max - min;

	if (delta === 0) {
		return { h: 0, s: 0, l };
	}

	const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
	let h = 0;
	switch (max) {
		case rn:
			h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) * 60;
			break;
		case gn:
			h = ((bn - rn) / delta + 2) * 60;
			break;
		default:
			h = ((rn - gn) / delta + 4) * 60;
	}
	return { h, s, l };
}

export function hslToRgb(input: HslColor): RgbColor {
	const { h, s, l } = normalizeHsl(input);
	if (s === 0) {
		const gray = normalizeChannel(l * 255);
		return { r: gray, g: gray, b: gray };
	}

	const hue = h / 360;
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	return {
		r: normalizeChannel(hueToRgb(p, q, hue + 1 / 3) * 255),
		g: normalizeChannel(hueToRgb(p, q, hue) * 255),
		b: normalizeChannel(hueToRgb(p, q, hue - 1 / 3) * 255),
	};
}

export function rgbToHsv(rgb: RgbColor): HsvColor;
export function rgbToHsv(r: number, g: number, b: number): HsvColor;
export function rgbToHsv(rgbOrR: RgbColor | number, g?: number, b?: number): HsvColor {
	const { r, g: green, b: blue } = parseRgbArgs(rgbOrR, g, b);
	const rn = r / 255;
	const gn = green / 255;
	const bn = blue / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const delta = max - min;
	let h = 0;

	if (delta !== 0) {
		switch (max) {
			case rn:
				h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) * 60;
				break;
			case gn:
				h = ((bn - rn) / delta + 2) * 60;
				break;
			default:
				h = ((rn - gn) / delta + 4) * 60;
		}
	}

	return {
		h,
		s: max === 0 ? 0 : delta / max,
		v: max,
	};
}

export function hsvToRgb(input: HsvColor): RgbColor {
	const { h, s, v } = normalizeHsv(input);
	if (s === 0) {
		const gray = normalizeChannel(v * 255);
		return { r: gray, g: gray, b: gray };
	}

	const c = v * s;
	const hPrime = h / 60;
	const x = c * (1 - Math.abs((hPrime % 2) - 1));
	const m = v - c;
	let rn = 0;
	let gn = 0;
	let bn = 0;

	if (hPrime >= 0 && hPrime < 1) {
		rn = c;
		gn = x;
	} else if (hPrime >= 1 && hPrime < 2) {
		rn = x;
		gn = c;
	} else if (hPrime >= 2 && hPrime < 3) {
		gn = c;
		bn = x;
	} else if (hPrime >= 3 && hPrime < 4) {
		gn = x;
		bn = c;
	} else if (hPrime >= 4 && hPrime < 5) {
		rn = x;
		bn = c;
	} else {
		rn = c;
		bn = x;
	}

	return {
		r: normalizeChannel((rn + m) * 255),
		g: normalizeChannel((gn + m) * 255),
		b: normalizeChannel((bn + m) * 255),
	};
}

export function hexToHsl(hex: string): HslColor {
	return rgbToHsl(hexToRgb(hex));
}

export function hexToHsv(hex: string): HsvColor {
	return rgbToHsv(hexToRgb(hex));
}

export function hslToHex(hsl: HslColor): HexColor {
	return rgbToHex(hslToRgb(hsl));
}

export function hsvToHex(hsv: HsvColor): HexColor {
	return rgbToHex(hsvToRgb(hsv));
}

export function hslToHsv(input: HslColor): HsvColor {
	const { h, s, l } = normalizeHsl(input);
	const v = l + s * Math.min(l, 1 - l);
	return {
		h,
		s: v === 0 ? 0 : 2 * (1 - l / v),
		v,
	};
}

export function hsvToHsl(input: HsvColor): HslColor {
	const { h, s, v } = normalizeHsv(input);
	const l = v * (1 - s / 2);
	return {
		h,
		s: l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l),
		l,
	};
}

export class ColorState {
	fg: HexColor;
	bg: HexColor;
	private readonly defaults: ColorPair;

	constructor(initial: Partial<ColorPair> = {}) {
		this.fg = normalizeHex(initial.fg ?? DEFAULT_FOREGROUND);
		this.bg = normalizeHex(initial.bg ?? DEFAULT_BACKGROUND);
		// Reset should return to the tool's starting colours, not whatever the last
		// mutation happened to be.
		this.defaults = { fg: this.fg, bg: this.bg };
	}

	setForeground(color: string): this {
		this.fg = normalizeHex(color);
		return this;
	}

	setBackground(color: string): this {
		this.bg = normalizeHex(color);
		return this;
	}

	swap(): this {
		const nextFg = this.bg;
		this.bg = this.fg;
		this.fg = nextFg;
		return this;
	}

	reset(): this {
		this.fg = this.defaults.fg;
		this.bg = this.defaults.bg;
		return this;
	}

	snapshot(): ColorPair {
		return { fg: this.fg, bg: this.bg };
	}
}

export class RecentColors {
	private readonly limit: number;
	private readonly items: HexColor[];

	constructor(initial: readonly string[] = [], limit = RECENT_COLORS_LIMIT) {
		assertInteger(limit, "limit");
		if (limit <= 0) {
			throw new RangeError("limit must be greater than 0");
		}
		this.limit = limit;
		this.items = [];
		const seen = new Set<HexColor>();
		for (const color of initial) {
			const normalized = normalizeHex(color);
			if (seen.has(normalized)) continue;
			seen.add(normalized);
			this.items.push(normalized);
			if (this.items.length === this.limit) break;
		}
	}

	add(color: string): HexColor[] {
		const normalized = normalizeHex(color);
		const existing = this.items.indexOf(normalized);
		if (existing !== -1) this.items.splice(existing, 1);
		this.items.unshift(normalized);
		if (this.items.length > this.limit) this.items.length = this.limit;
		return this.list();
	}

	remove(color: string): HexColor[] {
		const normalized = normalizeHex(color);
		const existing = this.items.indexOf(normalized);
		if (existing !== -1) this.items.splice(existing, 1);
		return this.list();
	}

	has(color: string): boolean {
		return this.items.includes(normalizeHex(color));
	}

	clear(): void {
		this.items.length = 0;
	}

	list(): HexColor[] {
		return [...this.items];
	}

	toJSON(): HexColor[] {
		return this.list();
	}
}

export function eyedropperSample(
	image: ImageDataLike,
	x: number,
	y: number,
	options: EyedropperOptions = {},
): RgbColor {
	const sampleSize = options.sampleSize ?? 1;
	if (sampleSize !== 1 && sampleSize !== 3 && sampleSize !== 5) {
		throw new RangeError("sampleSize must be 1, 3, or 5");
	}
	assertDimension(image.width, "width");
	assertDimension(image.height, "height");
	assertFiniteNumber(x, "x");
	assertFiniteNumber(y, "y");
	if (image.data.length < image.width * image.height * 4) {
		throw new RangeError("image data is shorter than width * height * 4");
	}

	const cx = Math.round(x);
	const cy = Math.round(y);
	if (cx < 0 || cy < 0 || cx >= image.width || cy >= image.height) {
		throw new RangeError("sample point is outside the image");
	}

	const radius = (sampleSize - 1) / 2;
	const minX = Math.max(0, cx - radius);
	const maxX = Math.min(image.width - 1, cx + radius);
	const minY = Math.max(0, cy - radius);
	const maxY = Math.min(image.height - 1, cy + radius);
	let r = 0;
	let g = 0;
	let b = 0;
	let count = 0;

	for (let py = minY; py <= maxY; py += 1) {
		for (let px = minX; px <= maxX; px += 1) {
			const offset = (py * image.width + px) * 4;
			r += pixelComponent(image.data, offset);
			g += pixelComponent(image.data, offset + 1);
			b += pixelComponent(image.data, offset + 2);
			count += 1;
		}
	}

	return {
		r: normalizeChannel(r / count),
		g: normalizeChannel(g / count),
		b: normalizeChannel(b / count),
	};
}

export function relativeLuminance(color: HexColor | string | RgbColor): number {
	const { r, g, b } = toRgbColor(color);
	const linear = (channel: number) => {
		const value = channel / 255;
		// WCAG contrast is defined on linearized sRGB, not arithmetic brightness.
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(foreground: HexColor | string | RgbColor, background: HexColor | string | RgbColor): number {
	const fg = relativeLuminance(foreground);
	const bg = relativeLuminance(background);
	const lighter = Math.max(fg, bg);
	const darker = Math.min(fg, bg);
	return (lighter + 0.05) / (darker + 0.05);
}

export function isReadable(foreground: HexColor | string | RgbColor, background: HexColor | string | RgbColor): boolean;
export function isReadable(
	foreground: HexColor | string | RgbColor,
	background: HexColor | string | RgbColor,
	level: WcagLevel,
	options?: Omit<ReadabilityOptions, "level">,
): boolean;
export function isReadable(
	foreground: HexColor | string | RgbColor,
	background: HexColor | string | RgbColor,
	options: ReadabilityOptions,
): boolean;
export function isReadable(
	foreground: HexColor | string | RgbColor,
	background: HexColor | string | RgbColor,
	levelOrOptions: WcagLevel | ReadabilityOptions = "AA",
	options: Omit<ReadabilityOptions, "level"> = {},
): boolean {
	const level = typeof levelOrOptions === "string" ? levelOrOptions : (levelOrOptions.level ?? "AA");
	const largeText = typeof levelOrOptions === "string" ? (options.largeText ?? false) : (levelOrOptions.largeText ?? false);
	const threshold = level === "AAA" ? (largeText ? 4.5 : 7) : (largeText ? 3 : 4.5);
	return contrastRatio(foreground, background) >= threshold;
}

export function nearestPaletteColor(
	color: HexColor | string | RgbColor,
	palette: readonly PaletteColor[] = MANGA_DEFAULT_PALETTE,
): PaletteColor {
	const [first, ...rest] = palette;
	if (!first) {
		throw new RangeError("palette must contain at least one color");
	}
	const target = toRgbColor(color);
	let best = first;
	const firstColor = hexToRgb(first.hex);
	let bestDistance =
		(target.r - firstColor.r) * (target.r - firstColor.r) +
		(target.g - firstColor.g) * (target.g - firstColor.g) +
		(target.b - firstColor.b) * (target.b - firstColor.b);

	for (const entry of rest) {
		const candidate = hexToRgb(entry.hex);
		const dr = target.r - candidate.r;
		const dg = target.g - candidate.g;
		const db = target.b - candidate.b;
		const distance = dr * dr + dg * dg + db * db;
		if (distance < bestDistance) {
			best = entry;
			bestDistance = distance;
		}
	}

	return best;
}
