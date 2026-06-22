import { describe, expect, it } from "vitest";
import {
	compositeDabs,
	dabAlphaMap,
	strokePlanner,
	type BrushDab,
	type BrushSettings,
} from "$lib/editor-tools/brush-engine.ts";

const BASE_SETTINGS: BrushSettings = {
	size: 12,
	hardness: 1,
	opacity: 1,
	flow: 1,
	spacingPct: 50,
	stabilizer: 0,
};

function transparentLayer(width: number, height: number): Uint8ClampedArray {
	return new Uint8ClampedArray(width * height * 4);
}

function alphaAt(layer: Uint8ClampedArray, width: number, x: number, y: number): number {
	return layer[(y * width + x) * 4 + 3];
}

function coverageAt(strokeAlpha: Float32Array, width: number, x: number, y: number): number {
	return strokeAlpha[y * width + x];
}

function nonZeroAlphaCount(layer: Uint8ClampedArray): number {
	let count = 0;
	for (let i = 3; i < layer.length; i += 4) {
		if (layer[i] > 0) count += 1;
	}
	return count;
}

function maxDabGap(dabs: readonly BrushDab[]): number {
	let maxGap = 0;
	for (let i = 1; i < dabs.length; i++) {
		maxGap = Math.max(maxGap, Math.hypot(dabs[i].x - dabs[i - 1].x, dabs[i].y - dabs[i - 1].y));
	}
	return maxGap;
}

describe("brush engine edge coverage", () => {
	it("renders soft brush falloff from opaque center to feathered edge", () => {
		const alphaMap = dabAlphaMap(9, 0.25);
		const center = 4 * 9 + 4;
		const midFeather = 4 * 9 + 6;
		const outerFeather = 4 * 9 + 8;
		const outsideCircle = 0;

		expect(alphaMap[center]).toBe(1);
		expect(alphaMap[midFeather]).toBeLessThan(alphaMap[center]);
		expect(alphaMap[midFeather]).toBeGreaterThan(alphaMap[outerFeather]);
		expect(alphaMap[outerFeather]).toBeGreaterThan(0);
		expect(alphaMap[outsideCircle]).toBe(0);

		const width = 15;
		const height = 15;
		const result = compositeDabs({
			width,
			height,
			layer: transparentLayer(width, height),
			dabs: [{ x: 7, y: 7, pressure: 1, size: 9, t: 0 }],
			settings: { ...BASE_SETTINGS, size: 9, hardness: 0.25 },
		});

		expect(alphaAt(result.layer, width, 7, 7)).toBe(255);
		expect(alphaAt(result.layer, width, 11, 7)).toBeGreaterThan(0);
		expect(alphaAt(result.layer, width, 11, 7)).toBeLessThan(alphaAt(result.layer, width, 9, 7));
		expect(alphaAt(result.layer, width, 0, 0)).toBe(0);
	});

	it("interpolates dabs across a far pointer gap at configured spacing", () => {
		const dabs = strokePlanner(
			[
				{ x: 0, y: 0, t: 0 },
				{ x: 120, y: 0, t: 120 },
			],
			{ ...BASE_SETTINGS, size: 12, spacingPct: 25 },
		);

		expect(dabs.length).toBeGreaterThan(35);
		expect(dabs[0]).toMatchObject({ x: 0, y: 0, t: 0 });
		expect(dabs.at(-1)?.x).toBeCloseTo(120, 5);
		expect(maxDabGap(dabs)).toBeLessThanOrEqual(3.05);
		for (let i = 1; i < dabs.length; i++) {
			expect(dabs[i].x).toBeGreaterThan(dabs[i - 1].x);
			expect(Math.abs(dabs[i].y)).toBeLessThan(0.0001);
		}
	});

	it("preserves pointer pressure through planning and uses it as dab strength", () => {
		const dabs = strokePlanner(
			[
				{ x: 0, y: 0, pressure: 0.2, t: 0 },
				{ x: 60, y: 0, pressure: 0.8, t: 60 },
			],
			{ ...BASE_SETTINGS, size: 10, spacingPct: 50 },
		);
		const middle = dabs[Math.floor(dabs.length / 2)];

		expect(dabs[0].pressure).toBeCloseTo(0.2, 6);
		expect(dabs.at(-1)?.pressure).toBeCloseTo(0.8, 6);
		expect(middle.pressure).toBeGreaterThan(0.35);
		expect(middle.pressure).toBeLessThan(0.65);

		const width = 16;
		const height = 16;
		const settings = { ...BASE_SETTINGS, size: 7, hardness: 1, opacity: 1, flow: 0.8 };
		const lowPressure = compositeDabs({
			width,
			height,
			layer: transparentLayer(width, height),
			dabs: [{ x: 8, y: 8, pressure: 0.25, size: 7, t: 0 }],
			settings,
		});
		const highPressure = compositeDabs({
			width,
			height,
			layer: transparentLayer(width, height),
			dabs: [{ x: 8, y: 8, pressure: 1, size: 7, t: 0 }],
			settings,
		});
		const zeroPressure = compositeDabs({
			width,
			height,
			layer: transparentLayer(width, height),
			dabs: [{ x: 8, y: 8, pressure: 0, size: 7, t: 0 }],
			settings,
		});

		expect(coverageAt(lowPressure.strokeAlpha, width, 8, 8)).toBeCloseTo(0.2, 6);
		expect(coverageAt(highPressure.strokeAlpha, width, 8, 8)).toBeCloseTo(0.8, 6);
		expect(alphaAt(lowPressure.layer, width, 8, 8)).toBeLessThan(alphaAt(highPressure.layer, width, 8, 8));
		expect(nonZeroAlphaCount(zeroPressure.layer)).toBe(0);
	});

	it("clips dabs at image edges and never wraps pixels across the layer", () => {
		const width = 8;
		const height = 8;
		const topLeft = compositeDabs({
			width,
			height,
			layer: transparentLayer(width, height),
			dabs: [{ x: -1, y: -1, pressure: 1, size: 6, t: 0 }],
			settings: { ...BASE_SETTINGS, size: 6 },
		});
		const bottomRight = compositeDabs({
			width,
			height,
			layer: transparentLayer(width, height),
			dabs: [{ x: 8, y: 8, pressure: 1, size: 6, t: 0 }],
			settings: { ...BASE_SETTINGS, size: 6 },
		});
		const fullyOutside = compositeDabs({
			width,
			height,
			layer: transparentLayer(width, height),
			dabs: [{ x: -100, y: 4, pressure: 1, size: 6, t: 0 }],
			settings: { ...BASE_SETTINGS, size: 6 },
		});

		expect(alphaAt(topLeft.layer, width, 0, 0)).toBeGreaterThan(0);
		expect(alphaAt(topLeft.layer, width, 7, 7)).toBe(0);
		expect(alphaAt(bottomRight.layer, width, 7, 7)).toBeGreaterThan(0);
		expect(alphaAt(bottomRight.layer, width, 0, 0)).toBe(0);
		expect(nonZeroAlphaCount(fullyOutside.layer)).toBe(0);
	});

	it("normalizes zero-size brushes to one pixel and handles brushes larger than the image", () => {
		const onePixelMap = dabAlphaMap(0, 1);
		expect([...onePixelMap]).toEqual([1]);

		const single = strokePlanner([{ x: 2, y: 3, pressure: 1, t: 0 }], {
			...BASE_SETTINGS,
			size: 0,
			spacingPct: 0,
		});
		expect(single).toEqual([{ x: 2, y: 3, pressure: 1, size: 1, t: 0 }]);

		const smallWidth = 5;
		const smallHeight = 4;
		const zeroSize = compositeDabs({
			width: smallWidth,
			height: smallHeight,
			layer: transparentLayer(smallWidth, smallHeight),
			dabs: [{ x: 2, y: 2, pressure: 1, size: 0, t: 0 }],
			settings: { ...BASE_SETTINGS, size: 0 },
		});
		const huge = compositeDabs({
			width: smallWidth,
			height: smallHeight,
			layer: transparentLayer(smallWidth, smallHeight),
			dabs: [{ x: 2, y: 2, pressure: 1, size: 101, t: 0 }],
			settings: { ...BASE_SETTINGS, size: 101, hardness: 1, flow: 0.5 },
		});

		expect(nonZeroAlphaCount(zeroSize.layer)).toBe(1);
		expect(alphaAt(zeroSize.layer, smallWidth, 2, 2)).toBe(255);
		expect(nonZeroAlphaCount(huge.layer)).toBe(smallWidth * smallHeight);
		expect(alphaAt(huge.layer, smallWidth, 0, 0)).toBe(128);
		expect(alphaAt(huge.layer, smallWidth, 4, 3)).toBe(128);
	});
});
