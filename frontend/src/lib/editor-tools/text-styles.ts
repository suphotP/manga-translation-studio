import type { TextLayerEffects, TextStylePresetStyle } from "$lib/types.js";

type SegmenterGranularity = "grapheme" | "word";

interface SegmenterEntry {
	segment: string;
	isWordLike?: boolean;
}

interface SegmenterLike {
	segment(input: string): Iterable<SegmenterEntry>;
}

type IntlWithOptionalSegmenter = typeof Intl & {
	Segmenter?: new (
		locales?: string | string[],
		options?: { granularity?: SegmenterGranularity },
	) => SegmenterLike;
};

export type TextStrokeJoin = "miter" | "round" | "bevel";

export interface TextGradientStop {
	offset: number;
	color: string;
}

export interface TextGradientFill {
	stops: TextGradientStop[];
	angle: number;
}

export type TextFill = string | TextGradientFill;

export interface TextStroke {
	color: string;
	width: number;
	join: TextStrokeJoin;
}

export interface TextShadow {
	color: string;
	blur: number;
	dx: number;
	dy: number;
}

export interface TextStyle {
	font: string;
	size: number;
	lineHeight: number;
	letterSpacing: number;
	fill: TextFill;
	strokes: TextStroke[];
	shadow?: TextShadow;
	verticalCJK?: boolean;
}

export interface TextPlanGlyph {
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
	index: number;
}

export interface TextPlanLine {
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
	glyphs: TextPlanGlyph[];
}

export interface TextInkBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface TextRenderPlan {
	text: string;
	style: TextStyle;
	orientation: "horizontal" | "vertical-rl";
	maxInlineSize: number;
	width: number;
	height: number;
	inkBounds: TextInkBounds;
	lines: TextPlanLine[];
}

export interface MangaTextStylePreset {
	id: "speech" | "shout" | "thought" | "narration" | "sfx";
	name: string;
	shortLabel: string;
	description: string;
	previewText: string;
	toolbarClass: string;
	style: TextStyle;
	layerStyle: TextStylePresetStyle;
}

interface BreakToken {
	text: string;
	removable: boolean;
}

const DEFAULT_TEXT_COLOR = "#111111";
const DEFAULT_FONT = "Noto Sans Thai, Tahoma, sans-serif";
const ZERO_WIDTH_SPACE = "\u200B";
const MIN_STYLE_SIZE = 1;
const MAX_STYLE_SIZE = 320;
const MIN_LINE_HEIGHT = 0.5;
const MAX_LINE_HEIGHT = 4;
const MIN_LETTER_SPACING = -120;
const MAX_LETTER_SPACING = 240;
const MAX_STROKES = 8;

export const DEFAULT_TEXT_STYLE: TextStyle = {
	font: DEFAULT_FONT,
	size: 28,
	lineHeight: 1.12,
	letterSpacing: 0,
	fill: DEFAULT_TEXT_COLOR,
	strokes: [
		{ color: "#ffffff", width: 4, join: "round" },
	],
};

export const MANGA_TEXT_STYLE_PRESETS: MangaTextStylePreset[] = [
	{
		id: "speech",
		name: "บับเบิลพูด",
		shortLabel: "พูด",
		description: "ตัวอ่านง่ายสำหรับบทสนทนาในบับเบิล",
		previewText: "คุย",
		toolbarClass: "speech",
		style: DEFAULT_TEXT_STYLE,
		layerStyle: {
			fontFamily: DEFAULT_FONT,
			fontSize: 26,
			fill: "#111111",
			stroke: "#ffffff",
			strokeWidth: 2,
			alignment: "center",
		},
	},
	{
		id: "shout",
		name: "ตะโกน",
		shortLabel: "ดัง",
		description: "น้ำหนักหนาและขอบกว้างสำหรับเสียงดังในบับเบิลแตก",
		previewText: "เฮ้!",
		toolbarClass: "shout",
		style: {
			font: "Arial Black, Noto Sans Thai, Tahoma, sans-serif",
			size: 42,
			lineHeight: 1,
			letterSpacing: 0,
			fill: "#111111",
			strokes: [
				{ color: "#ffffff", width: 9, join: "round" },
				{ color: "#111111", width: 2, join: "round" },
			],
			shadow: { color: "rgba(0, 0, 0, 0.34)", blur: 2, dx: 3, dy: 4 },
		},
		layerStyle: {
			fontFamily: "Arial Black, Noto Sans Thai, Tahoma, sans-serif",
			fontSize: 38,
			charSpacing: 18,
			fill: "#111111",
			stroke: "#ffffff",
			strokeWidth: 4,
			alignment: "center",
			effects: {
				dropShadow: {
					enabled: true,
					offsetX: 3,
					offsetY: 4,
					blur: 1,
					opacity: 42,
					color: "#111111",
				},
			},
		},
	},
	{
		id: "thought",
		name: "คิด",
		shortLabel: "คิด",
		description: "โทนอ่อนสำหรับ inner voice หรือบับเบิลความคิด",
		previewText: "คิด...",
		toolbarClass: "thought",
		style: {
			font: "Georgia, Noto Serif Thai, serif",
			size: 27,
			lineHeight: 1.18,
			letterSpacing: 0.2,
			fill: "#30323a",
			strokes: [
				{ color: "#ffffff", width: 3, join: "round" },
			],
			shadow: { color: "rgba(148, 163, 184, 0.34)", blur: 5, dx: 0, dy: 2 },
		},
		layerStyle: {
			fontFamily: "Noto Serif Thai, Georgia, serif",
			fontSize: 24,
			fill: "#30323a",
			stroke: "#ffffff",
			strokeWidth: 1.5,
			opacity: 0.92,
			alignment: "center",
			effects: {
				outerGlow: {
					enabled: true,
					color: "#cbd5e1",
					blur: 8,
					opacity: 34,
				},
			},
		},
	},
	{
		id: "narration",
		name: "บรรยาย",
		shortLabel: "บรร",
		description: "ตัวกระชับสำหรับกล่องคำบรรยายหรือป้ายเล่าเรื่อง",
		previewText: "ต่อมา",
		toolbarClass: "narration",
		style: {
			font: DEFAULT_FONT,
			size: 23,
			lineHeight: 1.16,
			letterSpacing: 0.1,
			fill: "#f8fafc",
			strokes: [
				{ color: "#111111", width: 4, join: "miter" },
				{ color: "#ffffff", width: 1, join: "round" },
			],
			shadow: { color: "rgba(0, 0, 0, 0.42)", blur: 1, dx: 2, dy: 2 },
		},
		layerStyle: {
			fontFamily: DEFAULT_FONT,
			fontSize: 22,
			fill: "#f8fafc",
			stroke: "#111111",
			strokeWidth: 2.5,
			alignment: "left",
			effects: {
				stroke: {
					enabled: true,
					color: "#111111",
					width: 2.5,
				},
			},
		},
	},
	{
		id: "sfx",
		name: "SFX",
		shortLabel: "SFX",
		description: "ตัวหนาเอียงพร้อมเงาซ้อนสำหรับเสียงประกอบบนภาพ",
		previewText: "ตึง!",
		toolbarClass: "sfx",
		style: {
			font: "Impact, Arial Black, Noto Sans Thai, sans-serif",
			size: 58,
			lineHeight: 0.96,
			letterSpacing: 0,
			fill: {
				angle: 92,
				stops: [
					{ offset: 0, color: "#fff7ed" },
					{ offset: 0.52, color: "#f97316" },
					{ offset: 1, color: "#7f1d1d" },
				],
			},
			strokes: [
				{ color: "#ffffff", width: 12, join: "round" },
				{ color: "#111111", width: 5, join: "round" },
				{ color: "#7f1d1d", width: 1.5, join: "round" },
			],
			shadow: { color: "rgba(127, 29, 29, 0.52)", blur: 3, dx: 8, dy: 9 },
		},
		layerStyle: {
			fontFamily: "Impact, Arial Black, Noto Sans Thai, sans-serif",
			fontSize: 60,
			charSpacing: 0,
			skewX: -8,
			fill: "#fff7ed",
			stroke: "#450a0a",
			strokeWidth: 8,
			alignment: "center",
			effects: {
				dropShadow: {
					enabled: true,
					offsetX: 8,
					offsetY: 9,
					blur: 2,
					opacity: 80,
					color: "#7f1d1d",
				},
				accentShadows: [
					{ enabled: true, color: "#f97316", offsetX: -5, offsetY: 4, blur: 0, opacity: 54 },
					{ enabled: true, color: "#111111", offsetX: 11, offsetY: 12, blur: 0, opacity: 70 },
				],
				passes: [
					{ enabled: true, fill: "#7f1d1d", stroke: "#450a0a", strokeWidth: 8, offsetX: 10, offsetY: 11, opacity: 76 },
				],
			},
		},
	},
];

function cloneTextLayerEffects(effects: TextLayerEffects | undefined): TextLayerEffects | undefined {
	if (!effects) return undefined;
	return {
		...(effects.stroke ? { stroke: { ...effects.stroke } } : {}),
		...(effects.outerGlow ? { outerGlow: { ...effects.outerGlow } } : {}),
		...(effects.dropShadow ? { dropShadow: { ...effects.dropShadow } } : {}),
		...(effects.accentShadows ? { accentShadows: effects.accentShadows.map((shadow) => ({ ...shadow })) } : {}),
		...(effects.passes ? { passes: effects.passes.map((pass) => ({ ...pass })) } : {}),
	};
}

export function getMangaTextStylePreset(presetId: MangaTextStylePreset["id"]): MangaTextStylePreset {
	const preset = MANGA_TEXT_STYLE_PRESETS.find((item) => item.id === presetId);
	if (!preset) {
		throw new Error(`Unknown manga text style preset: ${presetId}`);
	}
	return preset;
}

export function textLayerStyleFromMangaPreset(
	presetOrId: MangaTextStylePreset | MangaTextStylePreset["id"],
): TextStylePresetStyle {
	const preset = typeof presetOrId === "string" ? getMangaTextStylePreset(presetOrId) : presetOrId;
	const { effects, ...style } = preset.layerStyle;
	return {
		// Explicit neutral resets FIRST (codex P2): switching from a rich preset
		// (SFX/thought) to a simple one must not leave stale effects/skew/spacing
		// behind — applyTextStylePreset preserves omitted keys.
		effects: undefined,
		skewX: 0,
		charSpacing: 0,
		opacity: 1,
		...style,
		...(effects ? { effects: cloneTextLayerEffects(effects) } : {}),
	};
}

function intlSegmenter(granularity: SegmenterGranularity): SegmenterLike | null {
	const segmenter = (Intl as IntlWithOptionalSegmenter).Segmenter;
	if (!segmenter) return null;
	return new segmenter(["th", "ja", "zh", "en"], { granularity });
}

const graphemeSegmenter = intlSegmenter("grapheme");
const wordSegmenter = intlSegmenter("word");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	const numeric = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(numeric)) return fallback;
	return Math.min(max, Math.max(min, numeric));
}

function normalizeColor(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	if (!trimmed || /[\u0000-\u001f\u007f]/u.test(trimmed) || trimmed.length > 128) {
		return fallback;
	}
	return trimmed;
}

function normalizeStrokeJoin(value: unknown): TextStrokeJoin {
	return value === "miter" || value === "bevel" || value === "round" ? value : "round";
}

function normalizeFill(value: unknown): TextFill {
	if (typeof value === "string") return normalizeColor(value, DEFAULT_TEXT_COLOR);
	if (!isRecord(value) || !Array.isArray(value.stops)) return DEFAULT_TEXT_COLOR;

	const stops = value.stops
		.map((stop) => {
			if (!isRecord(stop)) return null;
			return {
				offset: clampNumber(stop.offset, 0, 1, 0),
				color: normalizeColor(stop.color, DEFAULT_TEXT_COLOR),
			};
		})
		.filter((stop): stop is TextGradientStop => stop !== null)
		.sort((a, b) => a.offset - b.offset)
		.slice(0, 12);

	if (stops.length < 2) return DEFAULT_TEXT_COLOR;
	return {
		angle: clampNumber(value.angle, -360, 360, 0),
		stops,
	};
}

function normalizeStrokes(value: unknown): TextStroke[] {
	if (!Array.isArray(value)) return DEFAULT_TEXT_STYLE.strokes.map((stroke) => ({ ...stroke }));
	const strokes = value
		.map((stroke) => {
			if (!isRecord(stroke)) return null;
			return {
				color: normalizeColor(stroke.color, "#ffffff"),
				width: clampNumber(stroke.width, 0, 128, 0),
				join: normalizeStrokeJoin(stroke.join),
			};
		})
		.filter((stroke): stroke is TextStroke => stroke !== null)
		.slice(0, MAX_STROKES);
	return strokes.length ? strokes : [];
}

function normalizeShadow(value: unknown): TextShadow | undefined {
	if (!isRecord(value)) return undefined;
	return {
		color: normalizeColor(value.color, "rgba(0, 0, 0, 0.35)"),
		blur: clampNumber(value.blur, 0, 240, 0),
		dx: clampNumber(value.dx, -512, 512, 0),
		dy: clampNumber(value.dy, -512, 512, 0),
	};
}

export function normalizeTextStyle(value: unknown): TextStyle {
	if (!isRecord(value)) return { ...DEFAULT_TEXT_STYLE, strokes: [...DEFAULT_TEXT_STYLE.strokes] };
	const style: TextStyle = {
		font: typeof value.font === "string" && value.font.trim() ? value.font.trim() : DEFAULT_TEXT_STYLE.font,
		size: clampNumber(value.size, MIN_STYLE_SIZE, MAX_STYLE_SIZE, DEFAULT_TEXT_STYLE.size),
		lineHeight: clampNumber(value.lineHeight, MIN_LINE_HEIGHT, MAX_LINE_HEIGHT, DEFAULT_TEXT_STYLE.lineHeight),
		letterSpacing: clampNumber(
			value.letterSpacing,
			MIN_LETTER_SPACING,
			MAX_LETTER_SPACING,
			DEFAULT_TEXT_STYLE.letterSpacing,
		),
		fill: normalizeFill(value.fill),
		strokes: normalizeStrokes(value.strokes),
	};
	const shadow = normalizeShadow(value.shadow);
	if (shadow) style.shadow = shadow;
	if (value.verticalCJK === true) style.verticalCJK = true;
	return style;
}

export function serializeTextStyle(style: TextStyle): string {
	return JSON.stringify(normalizeTextStyle(style));
}

export function deserializeTextStyle(serialized: string): TextStyle {
	let parsed: unknown;
	try {
		parsed = JSON.parse(serialized);
	} catch (error) {
		throw new Error("Invalid text style JSON", { cause: error });
	}
	return normalizeTextStyle(parsed);
}

function graphemes(value: string): string[] {
	if (!value) return [];
	if (!graphemeSegmenter) return Array.from(value);
	return Array.from(graphemeSegmenter.segment(value), (entry) => entry.segment);
}

function wordSegments(value: string): string[] {
	if (!value) return [];
	if (!wordSegmenter) return [value];
	const segments = Array.from(wordSegmenter.segment(value), (entry) => entry.segment).filter(Boolean);
	return segments.length ? segments : [value];
}

function isBreakSpace(value: string): boolean {
	return value !== ZERO_WIDTH_SPACE && /^\s+$/u.test(value);
}

function trimLineStart(value: string): string {
	return value.replace(/^[\s\u200B]+/u, "");
}

function trimLineEnd(value: string): string {
	return value.replace(/[\s\u200B]+$/u, "");
}

function tokenizeParagraph(paragraph: string): BreakToken[] {
	const tokens: BreakToken[] = [];
	let run = "";

	const flushRun = () => {
		if (!run) return;
		for (const segment of wordSegments(run)) {
			tokens.push({ text: segment, removable: false });
		}
		run = "";
	};

	for (const unit of graphemes(paragraph)) {
		if (unit === ZERO_WIDTH_SPACE) {
			flushRun();
			continue;
		}
		if (/^\s+$/u.test(unit)) {
			flushRun();
			tokens.push({ text: unit, removable: true });
			continue;
		}
		run += unit;
	}

	flushRun();
	return tokens;
}

function glyphWeight(grapheme: string): number {
	if (/^\s+$/u.test(grapheme)) return 0.34;
	if (/^[\p{Mark}]+$/u.test(grapheme)) return 0;
	if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(grapheme)) return 1;
	if (/^[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u.test(grapheme)) return 1;
	if (/^[\u0e00-\u0e7f]/u.test(grapheme)) return 0.68;
	if (/^[0-9]/u.test(grapheme)) return 0.56;
	if (/^[A-Z]/u.test(grapheme)) return 0.64;
	if (/^[a-z]/u.test(grapheme)) return 0.54;
	if (/^[.,:;'"!?()[\]{}|/\\`~_-]/u.test(grapheme)) return 0.36;
	return 0.72;
}

function estimateGlyphWidth(grapheme: string, style: TextStyle): number {
	return glyphWeight(grapheme) * style.size;
}

function measureHorizontalText(value: string, style: TextStyle): number {
	const units = graphemes(value).filter((unit) => unit !== ZERO_WIDTH_SPACE);
	if (!units.length) return 0;
	const glyphWidth = units.reduce((sum, unit) => sum + estimateGlyphWidth(unit, style), 0);
	return Math.max(0, glyphWidth + style.letterSpacing * Math.max(0, units.length - 1));
}

function measureVerticalText(value: string, style: TextStyle): number {
	const units = graphemes(value).filter((unit) => unit !== ZERO_WIDTH_SPACE && !isBreakSpace(unit));
	if (!units.length) return 0;
	return Math.max(0, units.length * style.size + style.letterSpacing * Math.max(0, units.length - 1));
}

function splitOverwideToken(
	token: string,
	maxInlineSize: number,
	style: TextStyle,
	measure: (value: string, style: TextStyle) => number,
): string[] {
	const lines: string[] = [];
	let current = "";

	for (const unit of graphemes(token)) {
		if (unit === ZERO_WIDTH_SPACE || (isBreakSpace(unit) && current === "")) continue;
		const candidate = current + unit;
		if (current && measure(candidate, style) > maxInlineSize) {
			lines.push(trimLineEnd(current));
			current = trimLineStart(unit);
		} else {
			current = candidate;
		}
	}

	if (current) lines.push(trimLineEnd(current));
	return lines.filter((line) => line.length > 0);
}

function wrapParagraph(
	paragraph: string,
	style: TextStyle,
	maxInlineSize: number,
	measure: (value: string, style: TextStyle) => number,
): string[] {
	if (paragraph === "") return [""];
	if (!Number.isFinite(maxInlineSize)) return [paragraph.replaceAll(ZERO_WIDTH_SPACE, "")];

	const lines: string[] = [];
	const tokens = tokenizeParagraph(paragraph);
	let current = "";

	for (const token of tokens) {
		if (token.removable && current === "") continue;
		const candidate = current + token.text;
		if (current && measure(candidate, style) > maxInlineSize) {
			lines.push(trimLineEnd(current));
			current = token.removable ? "" : trimLineStart(token.text);
		} else {
			current = candidate;
		}

		if (current && measure(current, style) > maxInlineSize) {
			const splitLines = splitOverwideToken(current, maxInlineSize, style, measure);
			lines.push(...splitLines.slice(0, -1));
			current = splitLines.at(-1) ?? "";
		}
	}

	if (current) lines.push(trimLineEnd(current));
	return lines.length ? lines : [""];
}

function wrapText(
	text: string,
	style: TextStyle,
	maxInlineSize: number,
	measure: (value: string, style: TextStyle) => number,
): string[] {
	if (!text) return [];
	return text
		.split(/\r\n|\n|\r/u)
		.flatMap((paragraph) => wrapParagraph(paragraph, style, maxInlineSize, measure));
}

function buildHorizontalGlyphs(line: string, style: TextStyle, y: number, startIndex: number): TextPlanGlyph[] {
	const glyphs: TextPlanGlyph[] = [];
	let cursorX = 0;
	let index = startIndex;

	for (const unit of graphemes(line)) {
		if (unit === ZERO_WIDTH_SPACE) continue;
		const width = estimateGlyphWidth(unit, style);
		glyphs.push({
			text: unit,
			x: cursorX,
			y,
			width,
			height: style.size,
			index,
		});
		cursorX += width + style.letterSpacing;
		index += 1;
	}

	return glyphs;
}

function buildVerticalGlyphs(line: string, style: TextStyle, x: number, startIndex: number): TextPlanGlyph[] {
	const glyphs: TextPlanGlyph[] = [];
	let cursorY = 0;
	let index = startIndex;

	for (const unit of graphemes(line)) {
		if (unit === ZERO_WIDTH_SPACE || isBreakSpace(unit)) continue;
		glyphs.push({
			text: unit,
			x,
			y: cursorY,
			width: estimateGlyphWidth(unit, style),
			height: style.size,
			index,
		});
		cursorY += style.size + style.letterSpacing;
		index += 1;
	}

	return glyphs;
}

function lineHeightPx(style: TextStyle): number {
	return style.size * style.lineHeight;
}

function inlineLimit(maxWidth: number): number {
	return Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : Number.POSITIVE_INFINITY;
}

function maxStrokeWidth(style: TextStyle): number {
	return style.strokes.reduce((max, stroke) => Math.max(max, stroke.width), 0);
}

function computeInkBounds(width: number, height: number, style: TextStyle): TextInkBounds {
	const strokeSpread = maxStrokeWidth(style);
	const shadow = style.shadow;
	const shadowLeft = shadow ? Math.min(0, shadow.dx - shadow.blur) : 0;
	const shadowRight = shadow ? Math.max(0, shadow.dx + shadow.blur) : 0;
	const shadowTop = shadow ? Math.min(0, shadow.dy - shadow.blur) : 0;
	const shadowBottom = shadow ? Math.max(0, shadow.dy + shadow.blur) : 0;
	const x = -strokeSpread + shadowLeft;
	const y = -strokeSpread + shadowTop;
	return {
		x,
		y,
		width: width + strokeSpread * 2 + shadowRight - shadowLeft,
		height: height + strokeSpread * 2 + shadowBottom - shadowTop,
	};
}

function renderHorizontalPlan(text: string, style: TextStyle, maxInlineSize: number): TextRenderPlan {
	const lineHeight = lineHeightPx(style);
	const wrappedLines = wrapText(text, style, maxInlineSize, measureHorizontalText);
	let glyphIndex = 0;
	const lines = wrappedLines.map((lineText, lineIndex) => {
		const y = lineIndex * lineHeight;
		const glyphs = buildHorizontalGlyphs(lineText, style, y, glyphIndex);
		glyphIndex += glyphs.length;
		return {
			text: lineText,
			x: 0,
			y,
			width: measureHorizontalText(lineText, style),
			height: lineHeight,
			glyphs,
		};
	});
	const width = lines.reduce((max, line) => Math.max(max, line.width), 0);
	const height = lines.length * lineHeight;
	return {
		text,
		style,
		orientation: "horizontal",
		maxInlineSize,
		width,
		height,
		inkBounds: computeInkBounds(width, height, style),
		lines,
	};
}

function renderVerticalPlan(text: string, style: TextStyle, maxInlineSize: number): TextRenderPlan {
	const columnAdvance = lineHeightPx(style);
	const wrappedColumns = wrapText(text, style, maxInlineSize, measureVerticalText);
	const width = wrappedColumns.length ? style.size + Math.max(0, wrappedColumns.length - 1) * columnAdvance : 0;
	const height = wrappedColumns.reduce((max, column) => Math.max(max, measureVerticalText(column, style)), 0);
	let glyphIndex = 0;
	const lines = wrappedColumns.map((lineText, columnIndex) => {
		const x = width - style.size - columnIndex * columnAdvance;
		const glyphs = buildVerticalGlyphs(lineText, style, x, glyphIndex);
		glyphIndex += glyphs.length;
		return {
			text: lineText,
			x,
			y: 0,
			width: style.size,
			height: measureVerticalText(lineText, style),
			glyphs,
		};
	});

	return {
		text,
		style,
		orientation: "vertical-rl",
		maxInlineSize,
		width,
		height,
		inkBounds: computeInkBounds(width, height, style),
		lines,
	};
}

export function renderPlan(text: string, style: TextStyle, maxWidth: number): TextRenderPlan {
	// The planner stays canvas-free; callers can replace this heuristic with real
	// renderer metrics later without changing wrapping, serialization, or presets.
	const normalizedStyle = normalizeTextStyle(style);
	const maxInlineSize = inlineLimit(maxWidth);
	return normalizedStyle.verticalCJK
		? renderVerticalPlan(text, normalizedStyle, maxInlineSize)
		: renderHorizontalPlan(text, normalizedStyle, maxInlineSize);
}
