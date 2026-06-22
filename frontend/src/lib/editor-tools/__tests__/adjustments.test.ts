import { describe, expect, it } from "vitest";
import {
	adjustHsl,
	applyLutRgb,
	buildBrightnessContrastLut,
	buildCurveLut,
	buildIdentityLut,
	buildLevelsLut,
	type ImageDataLike,
} from "$lib/editor-tools/adjustments.ts";

function bytes(values: number[]): Uint8ClampedArray {
	return new Uint8ClampedArray(values);
}

function image(values: number[]): ImageDataLike<Uint8ClampedArray> {
	return { width: values.length / 4, height: 1, data: bytes(values) };
}

function expectIdentityLut(lut: Uint8Array): void {
	expect([...lut]).toEqual(Array.from({ length: 256 }, (_, index) => index));
}

describe("buildLevelsLut", () => {
	it("builds an identity LUT for default levels", () => {
		expectIdentityLut(buildLevelsLut(0, 255, 1, 0, 255));
	});

	it("keeps gamma=1 as a linear input/output remap", () => {
		const lut = buildLevelsLut(10, 20, 1, 30, 230);
		expect(lut[0]).toBe(30);
		expect(lut[10]).toBe(30);
		expect(lut[15]).toBe(130);
		expect(lut[20]).toBe(230);
		expect(lut[255]).toBe(230);
	});

	it("uses gamma as a midtone control without moving black and white", () => {
		const brighterMids = buildLevelsLut(0, 255, 2, 0, 255);
		const darkerMids = buildLevelsLut(0, 255, 0.5, 0, 255);
		expect(brighterMids[0]).toBe(0);
		expect(brighterMids[255]).toBe(255);
		expect(brighterMids[64]).toBeGreaterThan(64);
		expect(darkerMids[192]).toBeLessThan(192);
	});

	it("handles collapsed input ranges without NaN/Infinity entries", () => {
		const lut = buildLevelsLut(128, 128, 1, 0, 255);
		expect(lut[0]).toBe(0);
		expect(lut[128]).toBe(0);
		expect(lut[129]).toBe(255);
		expect(lut.every((value) => Number.isInteger(value))).toBe(true);
	});
});

describe("buildCurveLut", () => {
	it("returns identity for an empty curve", () => {
		expectIdentityLut(buildCurveLut([]));
	});

	it("returns identity for identity endpoints", () => {
		expectIdentityLut(buildCurveLut([{ x: 0, y: 0 }, { x: 255, y: 255 }]));
	});

	it("keeps a monotonic curve monotonic", () => {
		const lut = buildCurveLut([
			{ x: 0, y: 0 },
			{ x: 48, y: 32 },
			{ x: 128, y: 140 },
			{ x: 220, y: 232 },
			{ x: 255, y: 255 },
		]);

		for (let i = 1; i < lut.length; i += 1) {
			expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
		}
	});

	it("prevents cubic overshoot inside each segment", () => {
		const points = [
			{ x: 0, y: 0 },
			{ x: 64, y: 220 },
			{ x: 128, y: 80 },
			{ x: 255, y: 255 },
		];
		const lut = buildCurveLut(points);

		for (let x = 64; x <= 128; x += 1) {
			expect(lut[x]).toBeGreaterThanOrEqual(80);
			expect(lut[x]).toBeLessThanOrEqual(220);
		}
		expect(Math.min(...lut)).toBeGreaterThanOrEqual(0);
		expect(Math.max(...lut)).toBeLessThanOrEqual(255);
	});

	it("sorts points and lets the last duplicate x win", () => {
		const lut = buildCurveLut([
			{ x: 255, y: 255 },
			{ x: 128, y: 90 },
			{ x: 0, y: 0 },
			{ x: 128, y: 120 },
		]);
		expect(lut[0]).toBe(0);
		expect(lut[128]).toBe(120);
		expect(lut[255]).toBe(255);
	});
});

describe("buildBrightnessContrastLut", () => {
	it("builds identity at zero brightness and zero contrast", () => {
		expectIdentityLut(buildBrightnessContrastLut(0, 0));
	});

	it("clamps brightness to full black/full white at the extremes", () => {
		expect(buildBrightnessContrastLut(-100, 0)[255]).toBe(0);
		expect(buildBrightnessContrastLut(100, 0)[0]).toBe(255);
	});

	it("maps contrast -100 to flat midpoint and contrast +100 away from midpoint", () => {
		const flat = buildBrightnessContrastLut(0, -100);
		expect(flat[0]).toBe(128);
		expect(flat[128]).toBe(128);
		expect(flat[255]).toBe(128);

		const high = buildBrightnessContrastLut(0, 100);
		expect(high[64]).toBeLessThan(64);
		expect(high[192]).toBeGreaterThan(192);
	});
});

describe("applyLutRgb", () => {
	it("applies an identity LUT as a no-op while returning a new image by default", () => {
		const source = image([10, 20, 30, 40, 200, 210, 220, 230]);
		const adjusted = applyLutRgb(source, buildIdentityLut());

		expect(adjusted).not.toBe(source);
		expect([...adjusted.data]).toEqual([...source.data]);
		expect([...source.data]).toEqual([10, 20, 30, 40, 200, 210, 220, 230]);
	});

	it("applies separate channel LUTs and preserves alpha", () => {
		const red = buildCurveLut([{ x: 0, y: 255 }, { x: 255, y: 0 }]);
		const green = buildIdentityLut();
		const blue = buildLevelsLut(0, 255, 1, 10, 20);
		const adjusted = applyLutRgb(image([10, 20, 30, 99]), { r: red, g: green, b: blue });

		expect([...adjusted.data]).toEqual([245, 20, 11, 99]);
	});

	it("mutates and returns the same image when inPlace is true", () => {
		const source = image([10, 20, 30, 40]);
		const adjusted = applyLutRgb(source, buildBrightnessContrastLut(100, 0), { inPlace: true });

		expect(adjusted).toBe(source);
		expect([...source.data]).toEqual([255, 255, 255, 40]);
	});

	it("rejects invalid LUT and RGBA buffer sizes", () => {
		expect(() => applyLutRgb(image([1, 2, 3, 4]), new Uint8Array(10))).toThrow(/256/);
		expect(() =>
			applyLutRgb({ width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3]) }, buildIdentityLut()),
		).toThrow(/multiple of 4/);
	});
});

describe("adjustHsl", () => {
	it("is an exact no-op for zero HSL adjustment and does not mutate by default", () => {
		const source = image([12, 34, 56, 78, 90, 120, 150, 180]);
		const adjusted = adjustHsl(source, { hue: 0, saturation: 0, lightness: 0 });

		expect(adjusted).not.toBe(source);
		expect([...adjusted.data]).toEqual([...source.data]);
		expect([...source.data]).toEqual([12, 34, 56, 78, 90, 120, 150, 180]);
	});

	it("rotates hue in fixed-point HSL space", () => {
		const adjusted = adjustHsl(image([255, 0, 0, 255]), { hue: 120 });
		expect([...adjusted.data]).toEqual([0, 255, 0, 255]);
	});

	it("desaturates to grayscale and preserves alpha", () => {
		const adjusted = adjustHsl(image([200, 100, 50, 77]), { saturation: -100 });
		const [r, g, b, a] = adjusted.data;
		expect(r).toBe(g);
		expect(g).toBe(b);
		expect(a).toBe(77);
	});

	it("moves HSL lightness toward black or white", () => {
		expect([...adjustHsl(image([120, 80, 40, 9]), { lightness: 100 }).data]).toEqual([255, 255, 255, 9]);
		expect([...adjustHsl(image([120, 80, 40, 9]), { lightness: -100 }).data]).toEqual([0, 0, 0, 9]);
	});

	it("supports in-place HSL adjustment", () => {
		const source = image([255, 0, 0, 10]);
		const adjusted = adjustHsl(source, { hue: -120 }, { inPlace: true });

		expect(adjusted).toBe(source);
		expect([...source.data]).toEqual([0, 0, 255, 10]);
	});
});
