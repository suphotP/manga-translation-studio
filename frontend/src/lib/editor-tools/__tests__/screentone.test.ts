import { describe, expect, it } from "vitest";
import { fillMaskWithTone, generateTone, gradientTone, type ScreentoneType } from "$lib/editor-tools/screentone.ts";

const TONE_TYPES: ScreentoneType[] = ["dot", "line", "cross", "noise"];

function alphaDensity(rgba: Uint8ClampedArray): number {
	let sum = 0;
	for (let i = 3; i < rgba.length; i += 4) sum += rgba[i];
	return sum / (rgba.length / 4) / 255;
}

function alphaAt(rgba: Uint8ClampedArray, width: number, x: number, y: number): number {
	return rgba[(y * width + x) * 4 + 3];
}

function averageAlphaInColumns(rgba: Uint8ClampedArray, width: number, height: number, x0: number, x1: number): number {
	let sum = 0;
	let count = 0;
	for (let y = 0; y < height; y++) {
		for (let x = x0; x < x1; x++) {
			sum += alphaAt(rgba, width, x, y);
			count++;
		}
	}
	return sum / count / 255;
}

function expectBlackTransparentRgba(rgba: Uint8ClampedArray): void {
	for (let i = 0; i < rgba.length; i += 4) {
		expect(rgba[i]).toBe(0);
		expect(rgba[i + 1]).toBe(0);
		expect(rgba[i + 2]).toBe(0);
	}
}

describe("generateTone", () => {
	it("matches the requested average density for every tone family", () => {
		for (const type of TONE_TYPES) {
			const tone = generateTone(128, 96, { type, density: 0.37, sizePx: 9, angleDeg: 27 });
			expect(tone.length).toBe(128 * 96 * 4);
			expectBlackTransparentRgba(tone);
			expect(Math.abs(alphaDensity(tone) - 0.37)).toBeLessThan(0.025);
		}
	});

	it("clamps density and handles empty dimensions", () => {
		expect(alphaDensity(generateTone(12, 10, { type: "dot", density: -1, sizePx: 6, angleDeg: 0 }))).toBe(0);
		expect(alphaDensity(generateTone(12, 10, { type: "line", density: 2, sizePx: 6, angleDeg: 0 }))).toBe(1);
		expect(generateTone(0, 10, { type: "noise", density: 0.5, sizePx: 6, angleDeg: 0 }).length).toBe(0);
		expect(generateTone(10, Number.NaN, { type: "cross", density: 0.5, sizePx: 6, angleDeg: 0 }).length).toBe(0);
	});

	it("generates tileable edges for dot, line, cross, and noise", () => {
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
});

describe("fillMaskWithTone", () => {
	it("writes tone only inside the mask and preserves unmasked pixels", () => {
		const width = 4;
		const height = 3;
		const data = new Uint8ClampedArray(width * height * 4);
		for (let i = 0; i < width * height; i++) {
			const offset = i * 4;
			data[offset] = 201;
			data[offset + 1] = 101;
			data[offset + 2] = 51;
			data[offset + 3] = 123;
		}
		const image = { width, height, data };
		const mask = new Uint8Array(width * height);
		mask[1] = 255;
		mask[6] = 128;
		mask[10] = 255;

		const result = fillMaskWithTone(image, mask, { type: "line", density: 1, sizePx: 4, angleDeg: 0 });

		expect(result).toBe(image);
		expect([...data.slice(0, 4)]).toEqual([201, 101, 51, 123]);
		expect([...data.slice(4, 8)]).toEqual([0, 0, 0, 255]);
		expect([...data.slice(6 * 4, 6 * 4 + 4)]).toEqual([0, 0, 0, 128]);
		expect([...data.slice(10 * 4, 10 * 4 + 4)]).toEqual([0, 0, 0, 255]);
		expect([...data.slice(11 * 4, 11 * 4 + 4)]).toEqual([201, 101, 51, 123]);
	});

	it("rejects mismatched mask and RGBA buffer sizes", () => {
		const image = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
		expect(() => fillMaskWithTone(image, new Uint8Array(3), { type: "dot", density: 0.5, sizePx: 4 })).toThrow();
		expect(() =>
			fillMaskWithTone({ width: 2, height: 2, data: new Uint8ClampedArray(12) }, new Uint8Array(4), {
				type: "dot",
				density: 0.5,
				sizePx: 4,
			}),
		).toThrow();
	});
});

describe("gradientTone", () => {
	it("ramps from light to dark along the requested axis", () => {
		const width = 120;
		const height = 48;
		const tone = gradientTone(width, height, {
			type: "dot",
			density: 0.8,
			fromDensity: 0.08,
			toDensity: 0.8,
			sizePx: 8,
			angleDeg: 15,
			axisDeg: 0,
		});
		const left = averageAlphaInColumns(tone, width, height, 0, 24);
		const right = averageAlphaInColumns(tone, width, height, 96, 120);

		expectBlackTransparentRgba(tone);
		expect(left).toBeLessThan(0.25);
		expect(right).toBeGreaterThan(0.55);
		expect(right).toBeGreaterThan(left + 0.35);
	});
});
