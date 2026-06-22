import { config } from "$lib/config.js";
import type { CreditPlacement, CreditPreset, TextLayer, TextStylePresetStyle } from "$lib/types.js";

const CREDIT_PLACEMENTS = new Set<CreditPlacement>(["top", "bottom", "left", "right"]);
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

type IdFactory = () => string;

type BuildCreditLayerOptions = {
	imageWidth: number;
	imageHeight: number;
	index: number;
	text?: string;
	offset?: number;
	idFactory?: IdFactory;
};

const baseCreditStyle: TextStylePresetStyle = {
	fontFamily: config.defaultFontFamily,
	fontSize: 16,
	fill: "#ffffff",
	stroke: "#111111",
	strokeWidth: 1.5,
	alignment: "center",
};

export const DEFAULT_CREDIT_PRESETS: CreditPreset[] = [
	{
		id: "credit-top-center",
		name: "บนกลาง",
		builtIn: true,
		text: "แปล / ไทป์เซ็ต",
		placement: "top",
		offset: 24,
		style: baseCreditStyle,
	},
	{
		id: "credit-bottom-center",
		name: "ล่างกลาง",
		builtIn: true,
		text: "แปล / ไทป์เซ็ต",
		placement: "bottom",
		offset: 24,
		style: baseCreditStyle,
	},
	{
		id: "credit-left-bottom",
		name: "ล่างซ้าย",
		builtIn: true,
		text: "แปล / ไทป์เซ็ต",
		placement: "left",
		offset: 24,
		style: { ...baseCreditStyle, alignment: "left" },
	},
	{
		id: "credit-right-bottom",
		name: "ล่างขวา",
		builtIn: true,
		text: "แปล / ไทป์เซ็ต",
		placement: "right",
		offset: 24,
		style: { ...baseCreditStyle, alignment: "right" },
	},
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeColor(value: unknown): string | undefined {
	return typeof value === "string" && HEX_COLOR_PATTERN.test(value) ? value : undefined;
}

function normalizeNumber(value: unknown, min: number, max: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(max, Math.max(min, value));
}

function normalizeAlignment(value: unknown): TextLayer["alignment"] | undefined {
	return value === "left" || value === "center" || value === "right" ? value : undefined;
}

function normalizeStyle(value: unknown): TextStylePresetStyle {
	if (!isRecord(value)) return {};

	const style: TextStylePresetStyle = {};
	const fontFamily = typeof value.fontFamily === "string" && value.fontFamily.trim()
		? value.fontFamily.trim()
		: undefined;
	const fontSize = normalizeNumber(value.fontSize, 1, 300);
	const fill = normalizeColor(value.fill);
	const stroke = normalizeColor(value.stroke);
	const strokeWidth = normalizeNumber(value.strokeWidth, 0, 64);
	const opacity = normalizeNumber(value.opacity, 0, 1);
	const alignment = normalizeAlignment(value.alignment);

	if (fontFamily) style.fontFamily = fontFamily;
	if (fontSize !== undefined) style.fontSize = fontSize;
	if (fill) style.fill = fill;
	if (stroke) style.stroke = stroke;
	if (strokeWidth !== undefined) style.strokeWidth = strokeWidth;
	if (opacity !== undefined) style.opacity = opacity;
	if (alignment) style.alignment = alignment;
	if (isRecord(value.effects)) style.effects = value.effects as TextStylePresetStyle["effects"];
	return style;
}

export function normalizeCreditPreset(value: unknown): CreditPreset | null {
	if (!isRecord(value)) return null;

	const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : null;
	const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : null;
	const text = typeof value.text === "string" && value.text.trim() ? value.text.trim() : null;
	const placement = CREDIT_PLACEMENTS.has(value.placement as CreditPlacement)
		? value.placement as CreditPlacement
		: null;
	const offset = normalizeNumber(value.offset, 0, 2048);
	if (!id || !name || !text || !placement || offset === undefined) return null;

	return {
		id,
		name,
		builtIn: value.builtIn === true,
		text,
		placement,
		offset,
		style: {
			...baseCreditStyle,
			...normalizeStyle(value.style),
		},
	};
}

export function getCreditPresets(customPresets: unknown): CreditPreset[] {
	const normalizedCustom = Array.isArray(customPresets)
		? customPresets.map(normalizeCreditPreset).filter((preset): preset is CreditPreset => preset !== null)
		: [];
	const customIds = new Set(normalizedCustom.map((preset) => preset.id));
	const defaults = DEFAULT_CREDIT_PRESETS.filter((preset) => !customIds.has(preset.id));
	return [...defaults, ...normalizedCustom];
}

export function buildCreditLayerFromPreset(preset: CreditPreset, options: BuildCreditLayerOptions): TextLayer {
	const imageWidth = Math.max(1, Math.round(options.imageWidth));
	const imageHeight = Math.max(1, Math.round(options.imageHeight));
	const offset = Math.max(0, Math.round(options.offset ?? preset.offset));
	const fontSize = Math.max(1, Math.round(preset.style.fontSize ?? baseCreditStyle.fontSize ?? 16));
	const boxHeight = Math.max(28, Math.round(fontSize * 2.4));
	const horizontalInset = Math.min(offset, Math.floor(imageWidth / 3));
	const horizontalWidth = Math.max(40, imageWidth - horizontalInset * 2);
	const sideWidth = Math.max(80, Math.min(Math.round(imageWidth * 0.48), 520));
	const yBottom = Math.max(0, imageHeight - offset - boxHeight);

	let box = {
		x: horizontalInset,
		y: offset,
		w: horizontalWidth,
		h: boxHeight,
	};

	if (preset.placement === "bottom") {
		box = { ...box, y: yBottom };
	} else if (preset.placement === "left") {
		box = {
			x: offset,
			y: yBottom,
			w: Math.min(sideWidth, Math.max(40, imageWidth - offset)),
			h: boxHeight,
		};
	} else if (preset.placement === "right") {
		const width = Math.min(sideWidth, Math.max(40, imageWidth - offset));
		box = {
			x: Math.max(0, imageWidth - offset - width),
			y: yBottom,
			w: width,
			h: boxHeight,
		};
	}

	const id = options.idFactory?.() ?? globalThis.crypto?.randomUUID?.() ?? `credit-${Date.now().toString(36)}`;
	return {
		id,
		text: options.text?.trim() || preset.text,
		sourceCategory: "credit",
		sourceProvider: "credit-preset",
		protected: true,
		...box,
		rotation: 0,
		fontSize,
		fontFamily: preset.style.fontFamily,
		fill: preset.style.fill,
		stroke: preset.style.stroke,
		strokeWidth: preset.style.strokeWidth,
		alignment: preset.style.alignment ?? "center",
		visible: true,
		locked: true,
		index: options.index,
		effects: preset.style.effects,
	};
}
