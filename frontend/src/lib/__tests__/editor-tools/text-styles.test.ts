import { describe, expect, expectTypeOf, it } from "vitest";
import {
	DEFAULT_TEXT_STYLE,
	MANGA_TEXT_STYLE_PRESETS,
	deserializeTextStyle,
	getMangaTextStylePreset,
	normalizeTextStyle,
	renderPlan,
	serializeTextStyle,
	textLayerStyleFromMangaPreset,
	type MangaTextStylePreset,
	type TextFill,
	type TextGradientFill,
	type TextGradientStop,
	type TextInkBounds,
	type TextPlanGlyph,
	type TextPlanLine,
	type TextRenderPlan,
	type TextShadow,
	type TextStroke,
	type TextStrokeJoin,
	type TextStyle,
} from "$lib/editor-tools/text-styles.js";

const BASE_STYLE: TextStyle = {
	font: "Noto Sans Thai, Tahoma, sans-serif",
	size: 10,
	lineHeight: 1.2,
	letterSpacing: 0,
	fill: "#111111",
	strokes: [
		{ color: "#ffffff", width: 4, join: "round" },
	],
};

describe("text style public export types", () => {
	it("keeps the exported TypeScript contracts aligned with runtime values", () => {
		expectTypeOf<TextStrokeJoin>().toEqualTypeOf<"miter" | "round" | "bevel">();
		expectTypeOf<TextGradientStop>().toMatchTypeOf<{ offset: number; color: string }>();
		expectTypeOf<TextGradientFill>().toMatchTypeOf<{ stops: TextGradientStop[]; angle: number }>();
		expectTypeOf<TextFill>().toEqualTypeOf<string | TextGradientFill>();
		expectTypeOf<TextStroke>().toMatchTypeOf<{ color: string; width: number; join: TextStrokeJoin }>();
		expectTypeOf<TextShadow>().toMatchTypeOf<{ color: string; blur: number; dx: number; dy: number }>();
		expectTypeOf<TextStyle>().toMatchTypeOf<{
			font: string;
			size: number;
			lineHeight: number;
			letterSpacing: number;
			fill: TextFill;
			strokes: TextStroke[];
			shadow?: TextShadow;
			verticalCJK?: boolean;
		}>();
		expectTypeOf<MangaTextStylePreset>().toMatchTypeOf<{
			id: "speech" | "shout" | "thought" | "narration" | "sfx";
			name: string;
			shortLabel: string;
			description: string;
			previewText: string;
			toolbarClass: string;
			style: TextStyle;
			layerStyle: object;
		}>();
		expectTypeOf<TextPlanGlyph>().toMatchTypeOf<{
			text: string;
			x: number;
			y: number;
			width: number;
			height: number;
			index: number;
		}>();
		expectTypeOf<TextPlanLine>().toMatchTypeOf<{
			text: string;
			x: number;
			y: number;
			width: number;
			height: number;
			glyphs: TextPlanGlyph[];
		}>();
		expectTypeOf<TextInkBounds>().toMatchTypeOf<{ x: number; y: number; width: number; height: number }>();
		expectTypeOf<TextRenderPlan>().toMatchTypeOf<{
			text: string;
			style: TextStyle;
			orientation: "horizontal" | "vertical-rl";
			maxInlineSize: number;
			width: number;
			height: number;
			inkBounds: TextInkBounds;
			lines: TextPlanLine[];
		}>();

		const presetIds: MangaTextStylePreset["id"][] = ["speech", "shout", "thought", "narration", "sfx"];

		expect(presetIds).toEqual(MANGA_TEXT_STYLE_PRESETS.map((preset) => preset.id));
	});
});

describe("text style presets", () => {
	it("exports a stable default speech style", () => {
		expect(DEFAULT_TEXT_STYLE).toEqual({
			font: "Noto Sans Thai, Tahoma, sans-serif",
			size: 28,
			lineHeight: 1.12,
			letterSpacing: 0,
			fill: "#111111",
			strokes: [
				{ color: "#ffffff", width: 4, join: "round" },
			],
		});
		expect(normalizeTextStyle(null)).toEqual(DEFAULT_TEXT_STYLE);
		expect(normalizeTextStyle({ ...BASE_STYLE, strokes: "bad" }).strokes).toEqual(DEFAULT_TEXT_STYLE.strokes);
		expect(normalizeTextStyle({ ...BASE_STYLE, strokes: "bad" }).strokes).not.toBe(DEFAULT_TEXT_STYLE.strokes);
	});

	it("ships the five manga presets as already-normalized styles", () => {
		expect(MANGA_TEXT_STYLE_PRESETS).toHaveLength(5);
		expect(MANGA_TEXT_STYLE_PRESETS.map((preset) => preset.id)).toEqual([
			"speech",
			"shout",
			"thought",
			"narration",
			"sfx",
		]);
		expect(new Set(MANGA_TEXT_STYLE_PRESETS.map((preset) => preset.id)).size).toBe(MANGA_TEXT_STYLE_PRESETS.length);

		for (const preset of MANGA_TEXT_STYLE_PRESETS) {
			expect(preset.name).not.toBe("");
			expect(preset.shortLabel).not.toBe("");
			expect(preset.description).not.toBe("");
			expect(preset.previewText).not.toBe("");
			expect(preset.toolbarClass).toMatch(/^[a-z-]+$/);
			expect(normalizeTextStyle(preset.style)).toEqual(preset.style);
		}
	});

	it("keeps preset outlines and layer styles suitable for Thai manga typesetting", () => {
		const speech = MANGA_TEXT_STYLE_PRESETS.find((preset) => preset.id === "speech");
		const shout = MANGA_TEXT_STYLE_PRESETS.find((preset) => preset.id === "shout");
		const thought = MANGA_TEXT_STYLE_PRESETS.find((preset) => preset.id === "thought");
		const narration = MANGA_TEXT_STYLE_PRESETS.find((preset) => preset.id === "narration");
		const sfx = MANGA_TEXT_STYLE_PRESETS.find((preset) => preset.id === "sfx");

		expect(MANGA_TEXT_STYLE_PRESETS.map((preset) => preset.name)).toEqual([
			"บับเบิลพูด",
			"ตะโกน",
			"คิด",
			"บรรยาย",
			"SFX",
		]);
		expect(speech?.style.strokes).toEqual(DEFAULT_TEXT_STYLE.strokes);
		expect(speech?.layerStyle).toEqual(expect.objectContaining({ fontSize: 26, alignment: "center", strokeWidth: 2 }));
		expect(shout?.style.strokes).toEqual([
			{ color: "#ffffff", width: 9, join: "round" },
			{ color: "#111111", width: 2, join: "round" },
		]);
		expect(shout?.layerStyle.effects?.dropShadow?.enabled).toBe(true);
		expect(thought?.layerStyle.opacity).toBeLessThan(1);
		expect(narration?.style.strokes[0]).toEqual({ color: "#111111", width: 4, join: "miter" });
		expect(narration?.layerStyle.alignment).toBe("left");
		expect(sfx?.style.strokes).toEqual([
			{ color: "#ffffff", width: 12, join: "round" },
			{ color: "#111111", width: 5, join: "round" },
			{ color: "#7f1d1d", width: 1.5, join: "round" },
		]);
		expect(sfx?.style.fill).toEqual({
			angle: 92,
			stops: [
				{ offset: 0, color: "#fff7ed" },
				{ offset: 0.52, color: "#f97316" },
				{ offset: 1, color: "#7f1d1d" },
			],
		});
		expect(sfx?.style.letterSpacing).toBe(0);
		expect(sfx?.layerStyle.effects?.passes).toHaveLength(1);
	});

	it("maps toolbar presets to cloned text-layer styles", () => {
		const sfxStyle = textLayerStyleFromMangaPreset("sfx");
		const sfxPreset = getMangaTextStylePreset("sfx");
		const thoughtStyle = textLayerStyleFromMangaPreset(getMangaTextStylePreset("thought"));

		// The mapped style ADDS explicit neutral resets (effects/skewX/charSpacing/
		// opacity) so simple presets clear rich leftovers — compare as superset.
		expect(sfxStyle).toEqual(expect.objectContaining(sfxPreset.layerStyle));
		expect(textLayerStyleFromMangaPreset("speech")).toEqual(expect.objectContaining({
			effects: undefined,
			skewX: 0,
			charSpacing: 0,
		}));
		expect(sfxStyle).not.toBe(sfxPreset.layerStyle);
		expect(sfxStyle.effects).not.toBe(sfxPreset.layerStyle.effects);
		expect(sfxStyle.effects?.passes).not.toBe(sfxPreset.layerStyle.effects?.passes);
		expect(thoughtStyle).toEqual(expect.objectContaining({
			fontFamily: "Noto Serif Thai, Georgia, serif",
			opacity: 0.92,
			alignment: "center",
		}));
	});

	it("rejects unknown toolbar preset ids loudly", () => {
		expect(() => getMangaTextStylePreset("missing" as MangaTextStylePreset["id"])).toThrow(
			"Unknown manga text style preset: missing",
		);
	});
});

describe("text style normalization and outlines", () => {
	it("trims valid fields, clamps unsafe values, sorts gradients, and normalizes outline joins", () => {
		const normalized = normalizeTextStyle({
			font: "  Custom Display  ",
			size: 0,
			lineHeight: 9,
			letterSpacing: -999,
			fill: {
				angle: 999,
				stops: [
					{ offset: 1.5, color: " #ffffff " },
					{ offset: -0.5, color: "#000000" },
				],
			},
			strokes: [
				{ color: "#111111", width: -4, join: "miter" },
				{ color: "", width: 12, join: "bevel" },
				{ color: "#333333", width: 999, join: "sideways" },
				"bad",
			],
			shadow: { color: "\u0000", blur: 999, dx: 999, dy: -999 },
			verticalCJK: "true",
		});

		expect(normalized).toEqual({
			font: "Custom Display",
			size: 1,
			lineHeight: 4,
			letterSpacing: -120,
			fill: {
				angle: 360,
				stops: [
					{ offset: 0, color: "#000000" },
					{ offset: 1, color: "#ffffff" },
				],
			},
			strokes: [
				{ color: "#111111", width: 0, join: "miter" },
				{ color: "#ffffff", width: 12, join: "bevel" },
				{ color: "#333333", width: 128, join: "round" },
			],
			shadow: { color: "rgba(0, 0, 0, 0.35)", blur: 240, dx: 512, dy: -512 },
		});
	});

	it("keeps explicit no-outline styles and caps stacked outline passes", () => {
		const noOutline = normalizeTextStyle({ ...BASE_STYLE, strokes: [] });
		const manyOutlines = normalizeTextStyle({
			...BASE_STYLE,
			strokes: Array.from({ length: 10 }, (_, index) => ({
				color: `#00000${index}`,
				width: index + 1,
				join: index % 2 === 0 ? "round" : "bevel",
			})),
		});

		expect(noOutline.strokes).toEqual([]);
		expect(manyOutlines.strokes).toHaveLength(8);
		expect(manyOutlines.strokes.at(0)).toEqual({ color: "#000000", width: 1, join: "round" });
		expect(manyOutlines.strokes.at(-1)).toEqual({ color: "#000007", width: 8, join: "bevel" });
	});
});

describe("text render planning", () => {
	it("wraps horizontal text at soft breaks and preserves grapheme clusters", () => {
		const plan = renderPlan("A\u200BB กำกำ", BASE_STYLE, 15);
		const clusterPlan = renderPlan("กำกำ", BASE_STYLE, 9);

		expect(plan.orientation).toBe("horizontal");
		expect(plan.maxInlineSize).toBe(15);
		expect(plan.lines.map((line) => line.text)).toEqual(["AB", "กำกำ"]);
		expect(plan.lines.flatMap((line) => line.glyphs.map((glyph) => glyph.text))).toEqual(["A", "B", "กำ", "กำ"]);
		expect(plan.lines.map((line) => line.y)).toEqual([0, 12]);
		expect(plan.width).toBeCloseTo(13.6);
		expect(plan.height).toBe(24);
		expect(clusterPlan.lines.map((line) => line.text)).toEqual(["กำ", "กำ"]);
		expect(clusterPlan.lines.flatMap((line) => line.glyphs.map((glyph) => glyph.text))).toEqual(["กำ", "กำ"]);
	});

	it("keeps blank lines and uses letter spacing in measurement and glyph placement", () => {
		const plan = renderPlan("Top\n\nAB", { ...BASE_STYLE, letterSpacing: 2 }, 999);

		expect(plan.lines.map((line) => line.text)).toEqual(["Top", "", "AB"]);
		expect(plan.lines[1].glyphs).toEqual([]);
		expect(plan.lines[2].glyphs.map((glyph) => glyph.x)).toEqual([0, 8.4]);
		expect(plan.lines[2].width).toBeCloseTo(14.8);
	});

	it("lays out vertical CJK columns from right to left and normalizes an invalid max width", () => {
		const wrapped = renderPlan("天地玄黄", { ...BASE_STYLE, verticalCJK: true }, 20);
		const unwrapped = renderPlan("天地玄黄", { ...BASE_STYLE, verticalCJK: true }, 0);

		expect(wrapped.orientation).toBe("vertical-rl");
		expect(wrapped.lines.map((line) => line.text)).toEqual(["天地", "玄黄"]);
		expect(wrapped.lines[0].x).toBeGreaterThan(wrapped.lines[1].x);
		expect(wrapped.lines[0].glyphs.map((glyph) => glyph.y)).toEqual([0, 10]);
		expect(wrapped.width).toBe(22);
		expect(wrapped.height).toBe(20);
		expect(unwrapped.maxInlineSize).toBe(Number.POSITIVE_INFINITY);
		expect(unwrapped.lines.map((line) => line.text)).toEqual(["天地玄黄"]);
	});

	it("expands ink bounds for the widest outline and shadow direction", () => {
		const plan = renderPlan(
			"AB",
			{
				...BASE_STYLE,
				lineHeight: 1,
				strokes: [
					{ color: "#ffffff", width: 3, join: "round" },
					{ color: "#111111", width: 1, join: "miter" },
				],
				shadow: { color: "rgba(0, 0, 0, 0.5)", blur: 2, dx: -4, dy: 5 },
			},
			999,
		);

		expect(plan.width).toBeCloseTo(12.8);
		expect(plan.height).toBe(10);
		expect(plan.inkBounds.x).toBe(-9);
		expect(plan.inkBounds.y).toBe(-3);
		expect(plan.inkBounds.width).toBeCloseTo(24.8);
		expect(plan.inkBounds.height).toBe(23);
	});
});

describe("text style serialization", () => {
	it("round-trips gradients, stacked outlines, shadows, and vertical layout mode with stable JSON", () => {
		const style: TextStyle = {
			font: "Impact, Arial Black, sans-serif",
			size: 58,
			lineHeight: 0.96,
			letterSpacing: -1,
			fill: {
				angle: 45,
				stops: [
					{ offset: 1, color: "#111111" },
					{ offset: 0, color: "#ffffff" },
				],
			},
			strokes: [
				{ color: "#ffffff", width: 10, join: "round" },
				{ color: "#111111", width: 3, join: "bevel" },
			],
			shadow: { color: "rgba(0, 0, 0, 0.5)", blur: 4, dx: 6, dy: 7 },
			verticalCJK: true,
		};

		const serialized = serializeTextStyle(style);
		const deserialized = deserializeTextStyle(serialized);

		expect(deserialized).toEqual({
			...style,
			fill: {
				angle: 45,
				stops: [
					{ offset: 0, color: "#ffffff" },
					{ offset: 1, color: "#111111" },
				],
			},
		});
		expect(serializeTextStyle(deserialized)).toBe(serialized);
	});

	it("normalizes deserialized JSON and reports invalid JSON clearly", () => {
		expect(deserializeTextStyle(JSON.stringify({ ...BASE_STYLE, font: "  Trim Me  ", size: 9999 }))).toMatchObject({
			font: "Trim Me",
			size: 320,
		});
		expect(() => deserializeTextStyle("{nope")).toThrow("Invalid text style JSON");
	});
});
