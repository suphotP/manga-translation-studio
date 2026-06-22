import { config } from "$lib/config.js";
import type { TextLayer, TextStylePreset, TextStylePresetStyle } from "$lib/types.js";

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export const DEFAULT_TEXT_STYLE_PRESETS: TextStylePreset[] = [
	{
		id: "builtin-dialogue",
		name: "บทพูด",
		builtIn: true,
		promptTags: ["dialogue", "speech", "bubble", "plain", "clean"],
		style: {
			fontFamily: config.defaultFontFamily,
			fontSize: 24,
			fill: "#111111",
			stroke: "#ffffff",
			strokeWidth: 2,
			alignment: "center",
		},
	},
	{
		id: "builtin-thought",
		name: "ความคิด",
		builtIn: true,
		promptTags: ["thought", "inner", "mind", "soft", "whisper"],
		style: {
			fontFamily: "Georgia, serif",
			fontSize: 23,
			fill: "#2f2f2f",
			stroke: "#ffffff",
			strokeWidth: 1.5,
			alignment: "center",
		},
	},
	{
		id: "builtin-narration",
		name: "คำบรรยาย",
		builtIn: true,
		promptTags: ["narration", "caption", "box", "story", "square"],
		style: {
			fontFamily: config.defaultFontFamily,
			fontSize: 20,
			fill: "#ffffff",
			stroke: "#111111",
			strokeWidth: 2,
			alignment: "left",
		},
	},
	{
		id: "builtin-sfx-draft",
		name: "SFX ร่าง",
		builtIn: true,
		promptTags: ["sfx", "sound", "impact", "draft", "bold"],
		style: {
			fontFamily: "Impact, Tahoma, sans-serif",
			fontSize: 42,
			fill: "#111111",
			stroke: "#ffffff",
			strokeWidth: 4,
			alignment: "center",
		},
	},
	{
		id: "builtin-sfx-impact-red",
		name: "ปะทะแดง",
		builtIn: true,
		promptTags: ["sfx", "impact", "angry", "shout", "burst", "red", "loud", "กรีดร้อง", "แดง"],
		style: {
			fontFamily: "Impact, Tahoma, sans-serif",
			fontSize: 54,
			fill: "#fff1f2",
			stroke: "#7f1d1d",
			strokeWidth: 6,
			alignment: "center",
			effects: {
				dropShadow: {
					enabled: true,
					offsetX: 6,
					offsetY: 7,
					blur: 1,
					opacity: 82,
					color: "#991b1b",
				},
				accentShadows: [
					{ enabled: true, color: "#450a0a", offsetX: -4, offsetY: 5, blur: 0, opacity: 72 },
					{ enabled: true, color: "#ef4444", offsetX: 10, offsetY: 12, blur: 0, opacity: 62 },
				],
				passes: [
					{ enabled: true, fill: "#7f1d1d", stroke: "#450a0a", strokeWidth: 7, offsetX: 10, offsetY: 11, opacity: 84 },
				],
			},
		},
	},
	{
		id: "builtin-sfx-dungeon-blue",
		name: "เวทดันเจี้ยน",
		builtIn: true,
		promptTags: ["sfx", "manhwa", "solo", "leveling", "dungeon", "magic", "mana", "blue", "aura", "action", "เวท", "ดันเจี้ยน", "น้ำเงิน"],
		style: {
			fontFamily: "Arial Black, Tahoma, sans-serif",
			fontSize: 58,
			charSpacing: 45,
			skewX: -8,
			fill: "#e0f7ff",
			stroke: "#020617",
			strokeWidth: 7,
			alignment: "center",
			effects: {
				outerGlow: {
					enabled: true,
					color: "#22d3ee",
					blur: 46,
					opacity: 94,
				},
				dropShadow: {
					enabled: true,
					offsetX: 5,
					offsetY: 6,
					blur: 0,
					opacity: 74,
					color: "#0f172a",
				},
				accentShadows: [
					{ enabled: true, color: "#67e8f9", offsetX: -8, offsetY: 0, blur: 14, opacity: 64 },
					{ enabled: true, color: "#1e3a8a", offsetX: 10, offsetY: 12, blur: 0, opacity: 88 },
				],
				passes: [
					{ enabled: true, fill: "#1e3a8a", stroke: "#020617", strokeWidth: 8, offsetX: 12, offsetY: 14, opacity: 86 },
					{ enabled: true, fill: "#155e75", stroke: "#0f172a", strokeWidth: 4, offsetX: -7, offsetY: 7, opacity: 58 },
				],
			},
		},
	},
	{
		id: "builtin-sfx-curse-violet",
		name: "คำสาปม่วง",
		builtIn: true,
		promptTags: ["sfx", "curse", "cursed", "horror", "dark", "eerie", "creepy", "purple", "monster", "คำสาป", "หลอน", "น่ากลัว", "ม่วง"],
		style: {
			fontFamily: "Arial Black, Tahoma, sans-serif",
			fontSize: 50,
			charSpacing: 130,
			skewX: 11,
			skewY: -3,
			fill: "#f5d0fe",
			stroke: "#2e1065",
			strokeWidth: 6,
			alignment: "center",
			effects: {
				outerGlow: {
					enabled: true,
					color: "#a855f7",
					blur: 34,
					opacity: 88,
				},
				accentShadows: [
					{ enabled: true, color: "#581c87", offsetX: -10, offsetY: 8, blur: 0, opacity: 72 },
					{ enabled: true, color: "#e879f9", offsetX: 7, offsetY: -6, blur: 18, opacity: 58 },
				],
				passes: [
					{ enabled: true, fill: "#4c1d95", stroke: "#1e1b4b", strokeWidth: 8, offsetX: -12, offsetY: 10, opacity: 74 },
				],
			},
		},
	},
	{
		id: "builtin-sfx-scream-red",
		name: "เสียงกรีดร้อง",
		builtIn: true,
		promptTags: ["sfx", "scream", "shout", "panic", "terror", "angry", "loud", "impact", "red", "กรีดร้อง", "ตะโกน", "ตกใจ", "แดง"],
		style: {
			fontFamily: "Arial Black, Tahoma, sans-serif",
			fontSize: 64,
			charSpacing: -25,
			skewX: -14,
			fill: "#fff1f2",
			stroke: "#450a0a",
			strokeWidth: 10,
			alignment: "center",
			effects: {
				outerGlow: {
					enabled: true,
					color: "#fb7185",
					blur: 18,
					opacity: 78,
				},
				dropShadow: {
					enabled: true,
					offsetX: 9,
					offsetY: 10,
					blur: 0,
					opacity: 92,
					color: "#991b1b",
				},
				accentShadows: [
					{ enabled: true, color: "#7f1d1d", offsetX: -9, offsetY: 8, blur: 0, opacity: 84 },
					{ enabled: true, color: "#dc2626", offsetX: 15, offsetY: 16, blur: 0, opacity: 70 },
					{ enabled: true, color: "#fecdd3", offsetX: -2, offsetY: -2, blur: 12, opacity: 46 },
				],
				passes: [
					{ enabled: true, fill: "#7f1d1d", stroke: "#450a0a", strokeWidth: 10, offsetX: 14, offsetY: 16, opacity: 88 },
					{ enabled: true, fill: "#b91c1c", stroke: "#450a0a", strokeWidth: 7, offsetX: -10, offsetY: 11, opacity: 64 },
				],
			},
		},
	},
	{
		id: "builtin-romance-gold",
		name: "โรแมนซ์ประกาย",
		builtIn: true,
		promptTags: ["romance", "cute", "medieval", "noble", "princess", "soft", "gold", "sparkle", "magic", "น่ารัก", "โรแมนซ์", "ยุคกลาง", "ผู้หญิง", "ทอง"],
		style: {
			fontFamily: "Georgia, Tahoma, serif",
			fontSize: 34,
			charSpacing: 30,
			skewX: 5,
			fill: "#fff7ed",
			stroke: "#7c2d12",
			strokeWidth: 4,
			alignment: "center",
			effects: {
				outerGlow: {
					enabled: true,
					color: "#facc15",
					blur: 28,
					opacity: 72,
				},
				accentShadows: [
					{ enabled: true, color: "#f97316", offsetX: 3, offsetY: 5, blur: 0, opacity: 46 },
					{ enabled: true, color: "#fde68a", offsetX: -4, offsetY: -3, blur: 16, opacity: 62 },
				],
				passes: [
					{ enabled: true, fill: "#f59e0b", stroke: "#7c2d12", strokeWidth: 5, offsetX: 5, offsetY: 7, opacity: 46 },
				],
			},
		},
	},
	{
		id: "builtin-sfx-haunt-stretch",
		name: "เสียงหลอนเลื้อย",
		builtIn: true,
		promptTags: ["sfx", "horror", "creepy", "haunt", "stretch", "snake", "curse", "ghost", "หลอน", "น่ากลัว", "เลื้อย", "ยาว", "คำสาป"],
		style: {
			fontFamily: "Georgia, Tahoma, serif",
			fontSize: 46,
			charSpacing: 180,
			skewX: 18,
			skewY: -6,
			fill: "#fde7ff",
			stroke: "#3b0764",
			strokeWidth: 5,
			alignment: "center",
			effects: {
				outerGlow: {
					enabled: true,
					color: "#c084fc",
					blur: 42,
					opacity: 86,
				},
				accentShadows: [
					{ enabled: true, color: "#4c1d95", offsetX: -14, offsetY: 10, blur: 0, opacity: 74 },
					{ enabled: true, color: "#a21caf", offsetX: 12, offsetY: -8, blur: 18, opacity: 54 },
				],
				passes: [
					{ enabled: true, fill: "#581c87", stroke: "#240046", strokeWidth: 7, offsetX: -16, offsetY: 11, opacity: 72 },
				],
			},
		},
	},
	{
		id: "builtin-whisper-glow",
		name: "เสียงเบาเรืองแสง",
		builtIn: true,
		promptTags: ["whisper", "soft", "air", "dream", "quiet", "inner", "thought"],
		style: {
			fontFamily: "Georgia, serif",
			fontSize: 24,
			fill: "#f8fafc",
			stroke: "#475569",
			strokeWidth: 1,
			alignment: "center",
			effects: {
				outerGlow: {
					enabled: true,
					color: "#93c5fd",
					blur: 10,
					opacity: 42,
				},
			},
		},
	},
	{
		id: "builtin-sign-plate",
		name: "ป้ายข้อความ",
		builtIn: true,
		promptTags: ["sign", "poster", "label", "notice", "flat", "caption"],
		style: {
			fontFamily: "Tahoma, sans-serif",
			fontSize: 22,
			fill: "#f8fafc",
			stroke: "#111111",
			strokeWidth: 2,
			alignment: "center",
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
		id: "builtin-credit",
		name: "เครดิต",
		builtIn: true,
		promptTags: ["credit", "watermark", "signature", "team"],
		style: {
			fontFamily: config.defaultFontFamily,
			fontSize: 16,
			fill: "#ffffff",
			stroke: "#111111",
			strokeWidth: 1.5,
			alignment: "center",
		},
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

function normalizeBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function normalizePromptTags(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const tags = Array.from(new Set(
		value
			.filter((tag): tag is string => typeof tag === "string")
			.map((tag) => tag.trim().toLowerCase())
			.filter(Boolean)
			.slice(0, 24)
	));
	return tags.length ? tags : undefined;
}

function normalizeTextLayerEffects(value: unknown): TextLayer["effects"] | undefined {
	if (!isRecord(value)) return undefined;
	const effects: TextLayer["effects"] = {};

	if (isRecord(value.stroke)) {
		const enabled = normalizeBoolean(value.stroke.enabled) ?? false;
		const color = normalizeColor(value.stroke.color);
		const width = normalizeNumber(value.stroke.width, 0, 64);
		if (enabled || color || width !== undefined) {
			effects.stroke = {
				enabled,
				color: color ?? "#111111",
				width: width ?? 2,
			};
		}
	}

	if (isRecord(value.outerGlow)) {
		const enabled = normalizeBoolean(value.outerGlow.enabled) ?? false;
		const color = normalizeColor(value.outerGlow.color);
		const blur = normalizeNumber(value.outerGlow.blur, 0, 200);
		const opacity = normalizeNumber(value.outerGlow.opacity, 0, 100);
		if (enabled || color || blur !== undefined || opacity !== undefined) {
			effects.outerGlow = {
				enabled,
				color: color ?? "#93c5fd",
				blur: blur ?? 8,
				opacity: opacity ?? 50,
			};
		}
	}

	if (isRecord(value.dropShadow)) {
		const enabled = normalizeBoolean(value.dropShadow.enabled) ?? false;
		const offsetX = normalizeNumber(value.dropShadow.offsetX, -512, 512);
		const offsetY = normalizeNumber(value.dropShadow.offsetY, -512, 512);
		const blur = normalizeNumber(value.dropShadow.blur, 0, 200);
		const opacity = normalizeNumber(value.dropShadow.opacity, 0, 100);
		const color = normalizeColor(value.dropShadow.color);
		if (
			enabled
			|| offsetX !== undefined
			|| offsetY !== undefined
			|| blur !== undefined
			|| opacity !== undefined
			|| color
		) {
			effects.dropShadow = {
				enabled,
				offsetX: offsetX ?? 4,
				offsetY: offsetY ?? 4,
				blur: blur ?? 4,
				opacity: opacity ?? 45,
				color: color ?? "#111111",
			};
		}
	}

	if (Array.isArray(value.accentShadows)) {
		const accentShadows = value.accentShadows
			.map((entry) => {
				if (!isRecord(entry)) return null;
				const enabled = normalizeBoolean(entry.enabled) ?? false;
				const offsetX = normalizeNumber(entry.offsetX, -512, 512);
				const offsetY = normalizeNumber(entry.offsetY, -512, 512);
				const blur = normalizeNumber(entry.blur, 0, 200);
				const opacity = normalizeNumber(entry.opacity, 0, 100);
				const color = normalizeColor(entry.color);
				if (
					!enabled
					&& offsetX === undefined
					&& offsetY === undefined
					&& blur === undefined
					&& opacity === undefined
					&& !color
				) {
					return null;
				}
				return {
					enabled,
					offsetX: offsetX ?? 0,
					offsetY: offsetY ?? 0,
					blur: blur ?? 0,
					opacity: opacity ?? 70,
					color: color ?? "#111111",
				};
			})
			.filter((entry): entry is NonNullable<TextLayer["effects"]>["accentShadows"][number] => entry !== null)
			.slice(0, 6);
		if (accentShadows.length) effects.accentShadows = accentShadows;
	}

	if (Array.isArray(value.passes)) {
		const passes = value.passes
			.map((entry) => {
				if (!isRecord(entry)) return null;
				const enabled = normalizeBoolean(entry.enabled) ?? false;
				const fill = normalizeColor(entry.fill);
				const stroke = normalizeColor(entry.stroke);
				const strokeWidth = normalizeNumber(entry.strokeWidth, 0, 64);
				const offsetX = normalizeNumber(entry.offsetX, -512, 512);
				const offsetY = normalizeNumber(entry.offsetY, -512, 512);
				const opacity = normalizeNumber(entry.opacity, 0, 100);
				if (
					!enabled
					&& !fill
					&& !stroke
					&& strokeWidth === undefined
					&& offsetX === undefined
					&& offsetY === undefined
					&& opacity === undefined
				) {
					return null;
				}
				return {
					enabled,
					...(fill ? { fill } : {}),
					...(stroke ? { stroke } : {}),
					...(strokeWidth !== undefined ? { strokeWidth } : {}),
					offsetX: offsetX ?? 0,
					offsetY: offsetY ?? 0,
					opacity: opacity ?? 100,
				};
			})
			.filter((entry): entry is NonNullable<TextLayer["effects"]>["passes"][number] => entry !== null)
			.slice(0, 6);
		if (passes.length) effects.passes = passes;
	}

	return Object.keys(effects).length ? effects : undefined;
}

export function buildTextStyleFromLayer(layer: TextLayer): TextStylePresetStyle {
	return {
		fontFamily: layer.fontFamily,
		fontSize: layer.fontSize,
		charSpacing: layer.charSpacing,
		skewX: layer.skewX,
		skewY: layer.skewY,
		fill: layer.fill,
		stroke: layer.stroke,
		strokeWidth: layer.strokeWidth,
		opacity: layer.opacity,
		alignment: layer.alignment,
		effects: layer.effects,
	};
}

export function normalizeTextStylePreset(value: unknown): TextStylePreset | null {
	if (!isRecord(value)) return null;

	const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : null;
	const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : null;
	const styleInput = isRecord(value.style) ? value.style : null;
	if (!id || !name || !styleInput) return null;

	const style: TextStylePresetStyle = {};
	const fontFamily = typeof styleInput.fontFamily === "string" && styleInput.fontFamily.trim()
		? styleInput.fontFamily.trim()
		: undefined;
	const fontSize = normalizeNumber(styleInput.fontSize, 1, 300);
	const charSpacing = normalizeNumber(styleInput.charSpacing, -500, 1000);
	const skewX = normalizeNumber(styleInput.skewX, -45, 45);
	const skewY = normalizeNumber(styleInput.skewY, -45, 45);
	const fill = normalizeColor(styleInput.fill);
	const stroke = normalizeColor(styleInput.stroke);
	const strokeWidth = normalizeNumber(styleInput.strokeWidth, 0, 64);
	const opacity = normalizeNumber(styleInput.opacity, 0, 1);
	const alignment = normalizeAlignment(styleInput.alignment);
	const effects = normalizeTextLayerEffects(styleInput.effects);
	const promptTags = normalizePromptTags(value.promptTags);

	if (fontFamily) style.fontFamily = fontFamily;
	if (fontSize !== undefined) style.fontSize = fontSize;
	if (charSpacing !== undefined) style.charSpacing = charSpacing;
	if (skewX !== undefined) style.skewX = skewX;
	if (skewY !== undefined) style.skewY = skewY;
	if (fill) style.fill = fill;
	if (stroke) style.stroke = stroke;
	if (strokeWidth !== undefined) style.strokeWidth = strokeWidth;
	if (opacity !== undefined) style.opacity = opacity;
	if (alignment) style.alignment = alignment;
	if (effects) style.effects = effects;

	return {
		id,
		name,
		builtIn: value.builtIn === true,
		...(promptTags ? { promptTags } : {}),
		style,
	};
}

export function getTextStylePresets(customPresets: unknown): TextStylePreset[] {
	const normalizedCustom = Array.isArray(customPresets)
		? customPresets.map(normalizeTextStylePreset).filter((preset): preset is TextStylePreset => preset !== null)
		: [];
	const customIds = new Set(normalizedCustom.map((preset) => preset.id));
	const defaults = DEFAULT_TEXT_STYLE_PRESETS.filter((preset) => !customIds.has(preset.id));
	return [...defaults, ...normalizedCustom];
}

function promptTokens(prompt: string): Set<string> {
	return new Set(
		prompt
			.toLowerCase()
			.split(/[^a-z0-9ก-ฮะ-์]+/u)
			.map((token) => token.trim())
			.filter(Boolean)
	);
}

function scorePresetForPrompt(preset: TextStylePreset, tokens: Set<string>): number {
	if (!tokens.size) return 0;
	const searchable = new Set([
		...preset.name.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean),
		...(preset.promptTags ?? []),
	]);
	let score = 0;
	for (const token of tokens) {
		if (searchable.has(token)) score += 3;
		for (const item of searchable) {
			if (item.includes(token) || token.includes(item)) score += 1;
		}
	}
	return score;
}

export function suggestTextStylePresetsForPrompt(
	prompt: string,
	presets: TextStylePreset[] = getTextStylePresets(undefined),
	limit = 3,
): TextStylePreset[] {
	const tokens = promptTokens(prompt);
	return presets
		.map((preset, index) => ({
			preset,
			index,
			score: scorePresetForPrompt(preset, tokens),
		}))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, Math.max(0, limit))
		.map((item) => item.preset);
}
