import { describe, expect, it } from "vitest";
import {
	eyedropperSample,
	hexToHsl,
	hexToRgb,
	hslToHex,
	hslToRgb,
	isValidHex,
	normalizeHex,
	rgbToHex,
	rgbToHsl,
} from "$lib/editor-tools/color-utils.ts";

const roundTripCases = [
	["#000000", { r: 0, g: 0, b: 0 }],
	["#ffffff", { r: 255, g: 255, b: 255 }],
	["#ff0000", { r: 255, g: 0, b: 0 }],
	["#00ff00", { r: 0, g: 255, b: 0 }],
	["#0000ff", { r: 0, g: 0, b: 255 }],
	["#808080", { r: 128, g: 128, b: 128 }],
	["#1a2b3c", { r: 26, g: 43, b: 60 }],
	["#c1121f", { r: 193, g: 18, b: 31 }],
	["#abcdef", { r: 171, g: 205, b: 239 }],
] as const;

describe("color-utils conversion roundtrips", () => {
	it("roundtrips canonical hex through RGB and HSL without byte drift", () => {
		for (const [hex, rgb] of roundTripCases) {
			expect(hexToRgb(hex)).toEqual(rgb);
			expect(rgbToHex(rgb)).toBe(hex);
			expect(hslToRgb(rgbToHsl(rgb))).toEqual(rgb);
			expect(hslToHex(hexToHsl(hex))).toBe(hex);
		}
	});

	it("normalizes short hex before roundtripping through RGB and HSL", () => {
		const normalized = normalizeHex("#AbC");
		const rgb = hexToRgb("#AbC");

		expect(normalized).toBe("#aabbcc");
		expect(rgbToHex(rgb)).toBe(normalized);
		expect(hslToHex(rgbToHsl(rgb))).toBe(normalized);
	});
});

describe("color-utils boundary and clamp behavior", () => {
	it("normalizes the 360 degree hue boundary and clamps generated grayscale channels to byte endpoints", () => {
		expect(hslToRgb({ h: 360, s: 1, l: 0.5 })).toEqual({ r: 255, g: 0, b: 0 });
		expect(hslToHex({ h: 360, s: 1, l: 0.5 })).toBe("#ff0000");
		expect(hslToRgb({ h: 0, s: 0, l: 0 })).toEqual({ r: 0, g: 0, b: 0 });
		expect(hslToRgb({ h: 0, s: 0, l: 1 })).toEqual({ r: 255, g: 255, b: 255 });
		expect(hslToRgb({ h: 0, s: 0, l: 128 / 255 })).toEqual({ r: 128, g: 128, b: 128 });
	});

	it("rejects invalid channels instead of silently clamping caller input", () => {
		expect(() => rgbToHex({ r: -1, g: 0, b: 0 })).toThrow(RangeError);
		expect(() => rgbToHex({ r: 256, g: 0, b: 0 })).toThrow(RangeError);
		expect(() => rgbToHex({ r: 12.5, g: 0, b: 0 })).toThrow(RangeError);
		expect(() => rgbToHex({ r: Number.NaN, g: 0, b: 0 })).toThrow(TypeError);
		expect(() => hslToRgb({ h: 361, s: 1, l: 0.5 })).toThrow(RangeError);
		expect(() => hslToRgb({ h: 0, s: -0.001, l: 0.5 })).toThrow(RangeError);
		expect(() => hslToRgb({ h: 0, s: 1, l: Number.POSITIVE_INFINITY })).toThrow(TypeError);
	});
});

describe("color-utils strict hex parsing", () => {
	it("accepts only #rgb or #rrggbb strings and normalizes case", () => {
		expect(isValidHex("#ABC")).toBe(true);
		expect(isValidHex("#a1B2c3")).toBe(true);
		expect(normalizeHex("#ABC")).toBe("#aabbcc");
		expect(normalizeHex("#a1B2c3")).toBe("#a1b2c3");
	});

	it("rejects whitespace, CSS functions, alpha suffixes, and malformed hex strings", () => {
		const malformed = [
			"",
			"fff",
			" #fff",
			"#fff ",
			"#ff",
			"#ffff",
			"#12345",
			"#1234567",
			"#12345g",
			"#12_345",
			"#ff ff",
			"rgb(255, 0, 0)",
			"rgba(255, 0, 0, 0.5)",
			"#11223344",
		];

		for (const value of malformed) {
			expect(isValidHex(value), value).toBe(false);
			expect(() => normalizeHex(value), value).toThrow(TypeError);
		}
	});
});

describe("color-utils alpha handling", () => {
	it("samples RGB bytes from RGBA data without alpha weighting", () => {
		const image = {
			width: 2,
			height: 1,
			data: [10, 20, 30, 0, 110, 120, 130, 255],
		};

		expect(eyedropperSample(image, 0, 0, { sampleSize: 3 })).toEqual({ r: 60, g: 70, b: 80 });
	});

	it("does not treat alpha as a color component validation gate", () => {
		expect(eyedropperSample({ width: 1, height: 1, data: [12, 34, 56, Number.NaN] }, 0, 0)).toEqual({
			r: 12,
			g: 34,
			b: 56,
		});
	});
});
