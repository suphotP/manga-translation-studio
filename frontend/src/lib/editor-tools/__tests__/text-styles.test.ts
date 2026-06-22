import { describe, expect, it } from "vitest";
import {
	MANGA_TEXT_STYLE_PRESETS,
	deserializeTextStyle,
	normalizeTextStyle,
	renderPlan,
	serializeTextStyle,
	type TextStyle,
} from "$lib/editor-tools/text-styles.js";

const baseStyle: TextStyle = {
	font: "Noto Sans Thai, Tahoma, sans-serif",
	size: 10,
	lineHeight: 1.2,
	letterSpacing: 0,
	fill: "#111111",
	strokes: [
		{ color: "#ffffff", width: 4, join: "round" },
	],
};

describe("manga text style presets", () => {
	it("ships exactly the five requested typesetting presets", () => {
		expect(MANGA_TEXT_STYLE_PRESETS.map((preset) => preset.id)).toEqual([
			"speech",
			"shout",
			"thought",
			"narration",
			"sfx",
		]);
		expect(MANGA_TEXT_STYLE_PRESETS).toHaveLength(5);
	});

	it("supports manga-style stacked strokes", () => {
		const shout = MANGA_TEXT_STYLE_PRESETS.find((preset) => preset.id === "shout");
		const sfx = MANGA_TEXT_STYLE_PRESETS.find((preset) => preset.id === "sfx");

		expect(shout?.style.strokes).toEqual([
			{ color: "#ffffff", width: 9, join: "round" },
			{ color: "#111111", width: 2, join: "round" },
		]);
		expect(sfx?.style.strokes.length).toBeGreaterThanOrEqual(3);
		expect(sfx?.style.fill).toEqual({
			angle: 92,
			stops: [
				{ offset: 0, color: "#fff7ed" },
				{ offset: 0.52, color: "#f97316" },
				{ offset: 1, color: "#7f1d1d" },
			],
		});
	});
});

describe("renderPlan horizontal wrapping", () => {
	it("wraps Thai at ZWSP and spaces without rendering the ZWSP marker", () => {
		const plan = renderPlan("แรก\u200Bสอง สาม", baseStyle, 24);

		expect(plan.orientation).toBe("horizontal");
		expect(plan.lines.map((line) => line.text)).toEqual(["แรก", "สอง", "สาม"]);
		expect(plan.lines.flatMap((line) => line.glyphs.map((glyph) => glyph.text))).not.toContain("\u200B");
		expect(plan.lines.map((line) => line.x)).toEqual([0, 0, 0]);
		expect(plan.lines.map((line) => line.y)).toEqual([0, 12, 24]);
	});

	it("does not split inside a grapheme cluster when a long token must be broken", () => {
		const plan = renderPlan("กำกำ", baseStyle, 9);

		expect(plan.lines.map((line) => line.text)).toEqual(["กำ", "กำ"]);
		expect(plan.lines.flatMap((line) => line.glyphs.map((glyph) => glyph.text))).toEqual(["กำ", "กำ"]);
		expect(plan.lines.some((line) => line.text === "\u0e33")).toBe(false);
	});

	it("uses letterSpacing in line measurement and glyph positions", () => {
		const plan = renderPlan("AB", { ...baseStyle, letterSpacing: 2 }, 999);

		expect(plan.lines).toHaveLength(1);
		expect(plan.lines[0].width).toBeCloseTo(14.8);
		expect(plan.lines[0].glyphs.map((glyph) => glyph.x)).toEqual([0, 8.4]);
	});

	it("keeps explicit blank lines in the render plan", () => {
		const plan = renderPlan("Top\n\nBottom", baseStyle, 999);

		expect(plan.lines.map((line) => line.text)).toEqual(["Top", "", "Bottom"]);
		expect(plan.height).toBe(36);
		expect(plan.lines[1].glyphs).toEqual([]);
	});
});

describe("renderPlan vertical CJK", () => {
	it("lays vertical columns from right to left", () => {
		const plan = renderPlan("天地玄黄", { ...baseStyle, verticalCJK: true }, 20);

		expect(plan.orientation).toBe("vertical-rl");
		expect(plan.lines.map((line) => line.text)).toEqual(["天地", "玄黄"]);
		expect(plan.lines[0].x).toBeGreaterThan(plan.lines[1].x);
		expect(plan.lines[0].glyphs.map((glyph) => glyph.y)).toEqual([0, 10]);
		expect(plan.width).toBe(22);
		expect(plan.height).toBe(20);
	});

	it("normalizes non-positive maxWidth to an unwrapped inline limit", () => {
		const plan = renderPlan("天地玄黄", { ...baseStyle, verticalCJK: true }, 0);

		expect(plan.lines.map((line) => line.text)).toEqual(["天地玄黄"]);
		expect(plan.maxInlineSize).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("text style serialization", () => {
	it("round-trips gradient fill, stacked strokes, shadow, and vertical mode", () => {
		const style: TextStyle = {
			font: "Impact, sans-serif",
			size: 48,
			lineHeight: 0.95,
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

	it("normalizes malformed style objects conservatively", () => {
		const normalized = normalizeTextStyle({
			font: "  ",
			size: 9999,
			lineHeight: -1,
			letterSpacing: 999,
			fill: { angle: 999, stops: [{ offset: 0.5, color: "" }] },
			strokes: [
				{ color: "#000000", width: 999, join: "sideways" },
				"bad",
			],
			shadow: { color: "", blur: 999, dx: -999, dy: 999 },
		});

		expect(normalized).toEqual({
			font: baseStyle.font,
			size: 320,
			lineHeight: 0.5,
			letterSpacing: 240,
			fill: "#111111",
			strokes: [
				{ color: "#000000", width: 128, join: "round" },
			],
			shadow: { color: "rgba(0, 0, 0, 0.35)", blur: 240, dx: -512, dy: 512 },
		});
	});

	it("throws a clear error for invalid serialized JSON", () => {
		expect(() => deserializeTextStyle("{nope")).toThrow("Invalid text style JSON");
	});
});
