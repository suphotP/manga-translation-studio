import { describe, expect, it } from "vitest";
import {
	fillMaskWithTone,
	generateTone,
	gradientTone,
	type GradientToneOptions,
	type ImageDataLike,
	type ScreentoneType,
	type ToneOptions,
} from "$lib/editor-tools/screentone.ts";

const TONE_TYPES: ScreentoneType[] = ["dot", "line", "cross", "noise"];

function alphaAt(rgba: Uint8ClampedArray, width: number, x: number, y: number): number {
	return rgba[(y * width + x) * 4 + 3];
}

function alphaDensity(rgba: Uint8ClampedArray): number {
	const pixelCount = rgba.length / 4;
	if (pixelCount === 0) return 0;
	let sum = 0;
	for (let offset = 3; offset < rgba.length; offset += 4) sum += rgba[offset];
	return sum / pixelCount / 255;
}

function paintedPixels(rgba: Uint8ClampedArray): number {
	let count = 0;
	for (let offset = 3; offset < rgba.length; offset += 4) {
		if (rgba[offset] > 0) count++;
	}
	return count;
}

function averageAlphaInRect(
	rgba: Uint8ClampedArray,
	width: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): number {
	let sum = 0;
	let count = 0;
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			sum += alphaAt(rgba, width, x, y);
			count++;
		}
	}
	return count === 0 ? 0 : sum / count / 255;
}

function expectBlackRgba(rgba: Uint8ClampedArray): void {
	for (let offset = 0; offset < rgba.length; offset += 4) {
		expect(rgba[offset]).toBe(0);
		expect(rgba[offset + 1]).toBe(0);
		expect(rgba[offset + 2]).toBe(0);
	}
}

function expectSameBytes(actual: Uint8ClampedArray, expected: Uint8ClampedArray): void {
	expect([...actual]).toEqual([...expected]);
}

function makeImage(width: number, height: number, color: readonly [number, number, number, number]): ImageDataLike {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < width * height; i++) data.set(color, i * 4);
	return { width, height, data };
}

function pixel(image: ImageDataLike, index: number): number[] {
	return [...image.data.slice(index * 4, index * 4 + 4)];
}

describe("generateTone", () => {
	it("generates black-on-transparent patterns at the requested density for every tone type", () => {
		const baseOptions: ToneOptions = { type: "dot", density: 0.37, sizePx: 9, angleDeg: 27 };

		for (const type of TONE_TYPES) {
			const tone = generateTone(128, 96, { ...baseOptions, type });

			expect(tone).toBeInstanceOf(Uint8ClampedArray);
			expect(tone.length).toBe(128 * 96 * 4);
			expectBlackRgba(tone);
			expect(Math.abs(alphaDensity(tone) - baseOptions.density)).toBeLessThan(0.025);
		}
	});

	it("is deterministic for each pattern family", () => {
		for (const type of TONE_TYPES) {
			const options: ToneOptions = { type, density: 0.43, sizePx: 7, angleDeg: 18 };

			expectSameBytes(generateTone(73, 41, options), generateTone(73, 41, options));
		}
	});

	it("uses dot size and line angle parameters to change the generated pattern", () => {
		const dotSmall = generateTone(48, 48, { type: "dot", density: 0.4, sizePx: 4, angleDeg: 0 });
		const dotLarge = generateTone(48, 48, { type: "dot", density: 0.4, sizePx: 12, angleDeg: 0 });
		const lineHorizontal = generateTone(48, 48, { type: "line", density: 0.4, sizePx: 8, angleDeg: 0 });
		const lineAngled = generateTone(48, 48, { type: "line", density: 0.4, sizePx: 8, angleDeg: 45 });

		expect([...dotSmall]).not.toEqual([...dotLarge]);
		expect([...lineHorizontal]).not.toEqual([...lineAngled]);
	});

	it("keeps noise deterministic and independent from geometric size or angle parameters", () => {
		const noiseA = generateTone(48, 32, { type: "noise", density: 0.41, sizePx: 3, angleDeg: 0 });
		const noiseB = generateTone(48, 32, { type: "noise", density: 0.41, sizePx: 99, angleDeg: 123 });

		expectSameBytes(noiseA, noiseB);
		expect(Math.abs(alphaDensity(noiseA) - 0.41)).toBeLessThan(0.035);
	});

	it("matches tile edges for every pattern so repeated textures do not seam", () => {
		const width = 65;
		const height = 49;

		for (const type of TONE_TYPES) {
			const tone = generateTone(width, height, { type, density: 0.42, sizePx: 8, angleDeg: 33 });

			for (let y = 0; y < height; y++) {
				expect(alphaAt(tone, width, 0, y)).toBe(alphaAt(tone, width, width - 1, y));
			}
			for (let x = 0; x < width; x++) {
				expect(alphaAt(tone, width, x, 0)).toBe(alphaAt(tone, width, x, height - 1));
			}
		}
	});

	it("normalizes zero, one-pixel, fractional, and non-finite dimensions", () => {
		const options: ToneOptions = { type: "cross", density: 0.5, sizePx: Number.NaN, angleDeg: Number.NaN };

		expect(generateTone(0, 10, options).length).toBe(0);
		expect(generateTone(10, 0, options).length).toBe(0);
		expect(generateTone(10, Number.NaN, options).length).toBe(0);
		expect(generateTone(2.9, 1.9, options).length).toBe(2 * 1 * 4);
		expect(generateTone(1, 1, { type: "dot", density: 0, sizePx: 4 })).toEqual(new Uint8ClampedArray(4));
		expect([...generateTone(1, 1, { type: "dot", density: 1, sizePx: 4 })]).toEqual([0, 0, 0, 255]);
	});

	it("clamps invalid density and rejects unsupported tone types", () => {
		expect(paintedPixels(generateTone(12, 10, { type: "dot", density: -1, sizePx: 6 }))).toBe(0);
		expect(alphaDensity(generateTone(12, 10, { type: "line", density: 2, sizePx: 6 }))).toBe(1);
		expect(() =>
			generateTone(4, 4, { type: "checker" as ScreentoneType, density: 0.5, sizePx: 4 }),
		).toThrow("Unsupported screentone type");
	});
});

describe("gradientTone", () => {
	it("ramps from light to dark along the requested horizontal axis", () => {
		const options: GradientToneOptions = {
			type: "dot",
			density: 0.8,
			fromDensity: 0.08,
			toDensity: 0.8,
			sizePx: 8,
			angleDeg: 15,
			axisDeg: 0,
		};
		const tone = gradientTone(120, 48, options);
		const left = averageAlphaInRect(tone, 120, 0, 0, 24, 48);
		const right = averageAlphaInRect(tone, 120, 96, 0, 120, 48);

		expectBlackRgba(tone);
		expect(left).toBeLessThan(0.25);
		expect(right).toBeGreaterThan(0.55);
		expect(right).toBeGreaterThan(left + 0.35);
	});

	it("supports vertical reversed ramps and clamps density endpoints", () => {
		const tone = gradientTone(72, 72, {
			type: "line",
			density: 0.4,
			fromDensity: 2,
			toDensity: -1,
			sizePx: 7,
			angleDeg: 0,
			axisDeg: 90,
		});
		const top = averageAlphaInRect(tone, 72, 0, 0, 72, 12);
		const bottom = averageAlphaInRect(tone, 72, 0, 60, 72, 72);

		expect(top).toBeGreaterThan(0.85);
		expect(bottom).toBeLessThan(0.15);
	});

	it("handles empty and single-pixel gradients without special callers", () => {
		expect(gradientTone(0, 8, { type: "noise", density: 0.5, sizePx: 4 }).length).toBe(0);
		expect(gradientTone(8, Number.POSITIVE_INFINITY, { type: "noise", density: 0.5, sizePx: 4 }).length).toBe(0);
		expect([...gradientTone(1, 1, { type: "cross", density: 0, fromDensity: 1, toDensity: 0, sizePx: 4 })]).toEqual([
			0, 0, 0, 255,
		]);
	});

	it("is deterministic for repeated gradient generation", () => {
		const options: GradientToneOptions = {
			type: "cross",
			density: 0.62,
			fromDensity: 0.2,
			toDensity: 0.9,
			sizePx: 5,
			angleDeg: 22,
			axisDeg: 135,
		};

		expectSameBytes(gradientTone(57, 33, options), gradientTone(57, 33, options));
	});
});

describe("fillMaskWithTone", () => {
	it("fills only masked pixels, scales feathered mask alpha, and returns the same image object", () => {
		const image = makeImage(4, 3, [201, 101, 51, 123]);
		const mask = new Uint8Array(12);
		mask[1] = 255;
		mask[6] = 128;
		mask[10] = 255;

		const result = fillMaskWithTone(image, mask, { type: "line", density: 1, sizePx: 4, angleDeg: 0 });

		expect(result).toBe(image);
		expect(pixel(image, 0)).toEqual([201, 101, 51, 123]);
		expect(pixel(image, 1)).toEqual([0, 0, 0, 255]);
		expect(pixel(image, 6)).toEqual([0, 0, 0, 128]);
		expect(pixel(image, 10)).toEqual([0, 0, 0, 255]);
		expect(pixel(image, 11)).toEqual([201, 101, 51, 123]);
	});

	it("writes transparent black only to masked pixels when the generated tone has no coverage", () => {
		const image = makeImage(2, 2, [9, 8, 7, 6]);
		const result = fillMaskWithTone(image, new Uint8Array([255, 0, 255, 0]), {
			type: "dot",
			density: 0,
			sizePx: 4,
		});

		expect(result).toBe(image);
		expect(pixel(image, 0)).toEqual([0, 0, 0, 0]);
		expect(pixel(image, 1)).toEqual([9, 8, 7, 6]);
		expect(pixel(image, 2)).toEqual([0, 0, 0, 0]);
		expect(pixel(image, 3)).toEqual([9, 8, 7, 6]);
	});

	it("accepts empty image and mask inputs", () => {
		const image: ImageDataLike = { width: 0, height: 4, data: new Uint8ClampedArray(0) };

		expect(fillMaskWithTone(image, new Uint8Array(0), { type: "noise", density: 0.5, sizePx: 4 })).toBe(image);
	});

	it("rejects mismatched RGBA buffer and mask sizes", () => {
		expect(() =>
			fillMaskWithTone({ width: 2, height: 2, data: new Uint8ClampedArray(12) }, new Uint8Array(4), {
				type: "dot",
				density: 0.5,
				sizePx: 4,
			}),
		).toThrow("expected 16 RGBA bytes");
		expect(() =>
			fillMaskWithTone({ width: 2, height: 2, data: new Uint8ClampedArray(16) }, new Uint8Array(3), {
				type: "dot",
				density: 0.5,
				sizePx: 4,
			}),
		).toThrow("expected 4 mask bytes");
	});
});
