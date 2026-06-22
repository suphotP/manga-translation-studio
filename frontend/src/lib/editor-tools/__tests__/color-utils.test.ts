import { describe, expect, it } from "vitest";
import {
	ColorState,
	MANGA_DEFAULT_PALETTE,
	RecentColors,
	contrastRatio,
	eyedropperSample,
	hexToHsl,
	hexToHsv,
	hexToRgb,
	hslToHex,
	hslToHsv,
	hslToRgb,
	hsvToHex,
	hsvToHsl,
	hsvToRgb,
	isReadable,
	isValidHex,
	nearestPaletteColor,
	normalizeHex,
	rgbToHex,
	rgbToHsl,
	rgbToHsv,
} from "$lib/editor-tools/color-utils.ts";

function makeImage(width: number, height: number, pixels: readonly number[]): ImageData {
	return new ImageData(new Uint8ClampedArray(pixels), width, height);
}

describe("hex and RGB conversions", () => {
	it("normalizes strict #rgb and #rrggbb hex input", () => {
		expect(normalizeHex("#ABC")).toBe("#aabbcc");
		expect(normalizeHex("#00fF7a")).toBe("#00ff7a");
		expect(isValidHex("#123")).toBe(true);
		expect(isValidHex("#112233")).toBe(true);
		expect(isValidHex("112233")).toBe(false);
		expect(isValidHex("#11223344")).toBe(false);
		expect(isValidHex("#12")).toBe(false);
		expect(isValidHex("#ggg")).toBe(false);
		expect(() => normalizeHex(" #fff")).toThrow(TypeError);
	});

	it("converts hex to RGB and RGB to lowercase hex", () => {
		expect(hexToRgb("#0f8")).toEqual({ r: 0, g: 255, b: 136 });
		expect(hexToRgb("#1a2b3c")).toEqual({ r: 26, g: 43, b: 60 });
		expect(rgbToHex({ r: 26, g: 43, b: 60 })).toBe("#1a2b3c");
		expect(rgbToHex(255, 255, 255)).toBe("#ffffff");
	});

	it("rejects non-integer and out-of-range RGB channels", () => {
		expect(() => rgbToHex({ r: -1, g: 0, b: 0 })).toThrow(RangeError);
		expect(() => rgbToHex({ r: 256, g: 0, b: 0 })).toThrow(RangeError);
		expect(() => rgbToHex({ r: 1.5, g: 0, b: 0 })).toThrow(RangeError);
		expect(() => rgbToHsl(Number.NaN, 0, 0)).toThrow(TypeError);
	});
});

describe("RGB, HSL, and HSV conversion edges", () => {
	it("converts RGB primaries to HSL", () => {
		expect(rgbToHsl(255, 0, 0)).toEqual({ h: 0, s: 1, l: 0.5 });
		expect(rgbToHsl(0, 255, 0).h).toBeCloseTo(120, 8);
		expect(rgbToHsl(0, 0, 255).h).toBeCloseTo(240, 8);
		expect(rgbToHsl(128, 128, 128)).toEqual({ h: 0, s: 0, l: 128 / 255 });
	});

	it("converts HSL back to RGB and hex at hue boundaries", () => {
		expect(hslToRgb({ h: 0, s: 1, l: 0.5 })).toEqual({ r: 255, g: 0, b: 0 });
		expect(hslToRgb({ h: 360, s: 1, l: 0.5 })).toEqual({ r: 255, g: 0, b: 0 });
		expect(hslToRgb({ h: 180, s: 1, l: 0.5 })).toEqual({ r: 0, g: 255, b: 255 });
		expect(hslToHex({ h: 240, s: 1, l: 0.5 })).toBe("#0000ff");
		expect(() => hslToRgb({ h: -0.01, s: 1, l: 0.5 })).toThrow(RangeError);
		expect(() => hslToRgb({ h: 0, s: 1.01, l: 0.5 })).toThrow(RangeError);
		expect(() => hslToRgb({ h: 0, s: 1, l: Number.POSITIVE_INFINITY })).toThrow(TypeError);
	});

	it("converts RGB primaries and black to HSV", () => {
		expect(rgbToHsv(255, 0, 0)).toEqual({ h: 0, s: 1, v: 1 });
		expect(rgbToHsv(0, 255, 0).h).toBeCloseTo(120, 8);
		expect(rgbToHsv(0, 0, 255).h).toBeCloseTo(240, 8);
		expect(rgbToHsv(0, 0, 0)).toEqual({ h: 0, s: 0, v: 0 });
	});

	it("converts HSV back to RGB and hex at hue boundaries", () => {
		expect(hsvToRgb({ h: 0, s: 1, v: 1 })).toEqual({ r: 255, g: 0, b: 0 });
		expect(hsvToRgb({ h: 360, s: 1, v: 1 })).toEqual({ r: 255, g: 0, b: 0 });
		expect(hsvToRgb({ h: 60, s: 1, v: 1 })).toEqual({ r: 255, g: 255, b: 0 });
		expect(hsvToHex({ h: 300, s: 1, v: 1 })).toBe("#ff00ff");
		expect(() => hsvToRgb({ h: 361, s: 1, v: 1 })).toThrow(RangeError);
		expect(() => hsvToRgb({ h: 0, s: -0.01, v: 1 })).toThrow(RangeError);
	});

	it("supports direct hex/HSL/HSV conversion helpers", () => {
		expect(hexToHsl("#ff0000")).toEqual({ h: 0, s: 1, l: 0.5 });
		expect(hexToHsv("#00ff00")).toEqual({ h: 120, s: 1, v: 1 });
		expect(hslToHsv({ h: 30, s: 1, l: 0.25 })).toEqual({ h: 30, s: 1, v: 0.5 });
		expect(hsvToHsl({ h: 30, s: 1, v: 0.5 })).toEqual({ h: 30, s: 1, l: 0.25 });
	});
});

describe("ColorState", () => {
	it("tracks foreground/background, swaps, and resets to constructor defaults", () => {
		const state = new ColorState({ fg: "#ABC", bg: "#123456" });
		expect(state.snapshot()).toEqual({ fg: "#aabbcc", bg: "#123456" });

		state.swap();
		expect(state.snapshot()).toEqual({ fg: "#123456", bg: "#aabbcc" });

		state.setForeground("#f00").setBackground("#0f0");
		expect(state.snapshot()).toEqual({ fg: "#ff0000", bg: "#00ff00" });

		state.reset();
		expect(state.snapshot()).toEqual({ fg: "#aabbcc", bg: "#123456" });
	});

	it("rejects invalid assigned colors through setters", () => {
		const state = new ColorState();
		expect(() => state.setForeground("#ffff")).toThrow(TypeError);
		expect(() => new ColorState({ fg: "black" as never })).toThrow(TypeError);
	});
});

describe("RecentColors", () => {
	it("keeps a normalized most-recent-first LRU list with duplicate refresh", () => {
		const recent = new RecentColors(["#AAA", "#bbbbbb", "#AAA"]);
		expect(recent.list()).toEqual(["#aaaaaa", "#bbbbbb"]);

		recent.add("#123456");
		expect(recent.list()).toEqual(["#123456", "#aaaaaa", "#bbbbbb"]);

		recent.add("#BBB");
		expect(recent.list()).toEqual(["#bbbbbb", "#123456", "#aaaaaa"]);
		expect(recent.has("#BBBBBB")).toBe(true);

		recent.remove("#123456");
		expect(recent.list()).toEqual(["#bbbbbb", "#aaaaaa"]);

		recent.clear();
		expect(recent.list()).toEqual([]);
	});

	it("caps the default LRU at 16 colors", () => {
		const recent = new RecentColors();
		for (let i = 0; i < 18; i += 1) {
			recent.add(`#${i.toString(16).padStart(6, "0")}`);
		}
		expect(recent.list()).toHaveLength(16);
		expect(recent.list()[0]).toBe("#000011");
		expect(recent.list()[15]).toBe("#000002");
		expect(recent.has("#000001")).toBe(false);
	});

	it("validates custom limits", () => {
		expect(() => new RecentColors([], 0)).toThrow(RangeError);
		expect(() => new RecentColors([], 1.5)).toThrow(RangeError);
	});
});

describe("eyedropperSample", () => {
	it("samples one exact pixel", () => {
		const image = makeImage(2, 1, [
			10, 20, 30, 255,
			200, 210, 220, 255,
		]);
		expect(eyedropperSample(image, 1, 0)).toEqual({ r: 200, g: 210, b: 220 });
	});

	it("averages a centered 3x3 sample", () => {
		const pixels: number[] = [];
		for (let i = 0; i < 9; i += 1) {
			pixels.push(i * 10, i * 10 + 1, i * 10 + 2, 255);
		}
		const image = makeImage(3, 3, pixels);
		expect(eyedropperSample(image, 1, 1, { sampleSize: 3 })).toEqual({ r: 40, g: 41, b: 42 });
	});

	it("clips multi-pixel samples at image edges", () => {
		const image = makeImage(3, 3, [
			0, 0, 0, 255,
			30, 30, 30, 255,
			200, 200, 200, 255,
			60, 60, 60, 255,
			90, 90, 90, 255,
			200, 200, 200, 255,
			200, 200, 200, 255,
			200, 200, 200, 255,
			200, 200, 200, 255,
		]);
		expect(eyedropperSample(image, 0, 0, { sampleSize: 3 })).toEqual({ r: 45, g: 45, b: 45 });
	});

	it("validates sample size, bounds, dimensions, and data length", () => {
		const image = makeImage(1, 1, [1, 2, 3, 255]);
		expect(() => eyedropperSample(image, 0, 0, { sampleSize: 2 as never })).toThrow(RangeError);
		expect(() => eyedropperSample(image, -1, 0)).toThrow(RangeError);
		expect(() => eyedropperSample({ data: [1, 2, 3], width: 1, height: 1 }, 0, 0)).toThrow(RangeError);
		expect(() => eyedropperSample({ data: [1, 2, 3, 4], width: 0, height: 1 }, 0, 0)).toThrow(RangeError);
		expect(() => eyedropperSample({ data: [999, 0, 0, 255], width: 1, height: 1 }, 0, 0)).toThrow(RangeError);
	});
});

describe("manga palette and nearest color", () => {
	it("exports the default manga palette colors", () => {
		expect(MANGA_DEFAULT_PALETTE.map((entry) => entry.hex)).toEqual([
			"#ffffff",
			"#000000",
			"#404040",
			"#808080",
			"#c0c0c0",
			"#c1121f",
		]);
	});

	it("returns the nearest palette entry and keeps tie order stable", () => {
		expect(nearestPaletteColor("#fdfdfd").hex).toBe("#ffffff");
		expect(nearestPaletteColor({ r: 195, g: 18, b: 32 }).hex).toBe("#c1121f");
		expect(
			nearestPaletteColor("#7f0000", [
				{ name: "first", hex: "#000000" },
				{ name: "second", hex: "#fe0000" },
			]).name,
		).toBe("first");
		expect(() => nearestPaletteColor("#fff", [])).toThrow(RangeError);
	});
});

describe("contrast and readability", () => {
	it("computes WCAG contrast ratios", () => {
		expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 6);
		expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 6);
		expect(contrastRatio({ r: 0, g: 0, b: 255 }, "#ffffff")).toBeCloseTo(8.592, 3);
	});

	it("checks AA and AAA readability thresholds", () => {
		expect(isReadable("#000000", "#ffffff")).toBe(true);
		expect(isReadable("#767676", "#ffffff", "AA")).toBe(true);
		expect(isReadable("#767676", "#ffffff", "AAA")).toBe(false);
		expect(isReadable("#949494", "#ffffff", { level: "AA" })).toBe(false);
		expect(isReadable("#949494", "#ffffff", { level: "AA", largeText: true })).toBe(true);
		expect(isReadable("#767676", "#ffffff", "AAA", { largeText: true })).toBe(true);
	});
});
