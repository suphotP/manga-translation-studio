import { describe, expect, it } from "vitest";
import {
	clearDabAlphaMapCache,
	compositeDabs,
	dabAlphaMap,
	strokePlanner,
	type BrushDab,
	type BrushSettings,
} from "$lib/editor-tools/brush-engine.ts";

const BASE_SETTINGS: BrushSettings = {
	size: 10,
	hardness: 1,
	opacity: 1,
	flow: 1,
	spacingPct: 50,
	stabilizer: 0,
};

function transparentLayer(width: number, height: number): Uint8ClampedArray {
	return new Uint8ClampedArray(width * height * 4);
}

function pixelAlpha(layer: Uint8ClampedArray, width: number, x: number, y: number): number {
	return layer[(y * width + x) * 4 + 3];
}

describe("strokePlanner", () => {
	it("places dabs at brush-size spacing along distance", () => {
		const dabs = strokePlanner(
			[
				{ x: 0, y: 0, t: 0 },
				{ x: 20, y: 0, t: 100 },
			],
			BASE_SETTINGS,
		);

		expect(dabs).toHaveLength(5);
		expect(dabs.map((dab) => Math.round(dab.x))).toEqual([0, 5, 10, 15, 20]);
		for (let i = 1; i < dabs.length; i++) {
			const dx = dabs[i].x - dabs[i - 1].x;
			const dy = dabs[i].y - dabs[i - 1].y;
			expect(Math.hypot(dx, dy)).toBeCloseTo(5, 5);
		}
	});

	it("smooths curved input with Catmull-Rom without losing endpoints", () => {
		const dabs = strokePlanner(
			[
				{ x: 0, y: 0, t: 0 },
				{ x: 10, y: 10, t: 10 },
				{ x: 20, y: 0, t: 20 },
				{ x: 30, y: 10, t: 30 },
			],
			{ ...BASE_SETTINGS, size: 8, spacingPct: 50 },
		);

		expect(dabs[0]).toMatchObject({ x: 0, y: 0, t: 0 });
		expect(dabs.length).toBeGreaterThan(8);
		expect(dabs.some((dab) => dab.y > 0 && dab.y < 10)).toBe(true);
		expect(dabs.at(-1)?.x).toBeCloseTo(28.3, 0);
	});

	it("reduces pointer jitter when stabilizer is enabled", () => {
		const events = [
			{ x: 0, y: 0, t: 0 },
			{ x: 5, y: 5, t: 1 },
			{ x: 10, y: -5, t: 2 },
			{ x: 15, y: 5, t: 3 },
			{ x: 20, y: -5, t: 4 },
			{ x: 25, y: 0, t: 5 },
		];
		const raw = strokePlanner(events, { ...BASE_SETTINGS, size: 4, spacingPct: 100, stabilizer: 0 });
		const stabilized = strokePlanner(events, { ...BASE_SETTINGS, size: 4, spacingPct: 100, stabilizer: 0.8 });

		const rawJitter = maxAbsY(raw);
		const stabilizedJitter = maxAbsY(stabilized);
		expect(stabilizedJitter).toBeLessThan(rawJitter * 0.45);
	});

	it("returns no dabs for empty input and one dab for a single pointer event", () => {
		expect(strokePlanner([], BASE_SETTINGS)).toEqual([]);
		expect(strokePlanner([{ x: 4, y: 7, pressure: 0.4, t: 12 }], BASE_SETTINGS)).toEqual([
			{ x: 4, y: 7, pressure: 0.4, size: 10, t: 12 },
		]);
	});
});

describe("dabAlphaMap", () => {
	it("caches maps by normalized size and hardness", () => {
		clearDabAlphaMapCache();
		const first = dabAlphaMap(10.2, 0.4998);
		const second = dabAlphaMap(10.1, 0.5);
		expect(first).toBe(second);
		expect(first.length).toBe(11 * 11);
	});

	it("makes soft hardness fade at the edge while hard brushes stay opaque inside the circle", () => {
		const soft = dabAlphaMap(9, 0);
		const hard = dabAlphaMap(9, 1);
		const center = 4 * 9 + 4;
		const edge = 4 * 9 + 8;

		expect(soft[center]).toBe(1);
		expect(soft[edge]).toBeGreaterThan(0);
		expect(soft[edge]).toBeLessThan(1);
		expect(hard[edge]).toBe(1);
	});
});

describe("compositeDabs", () => {
	it("keeps per-stroke opacity capped even when flow accumulates across many dabs", () => {
		const width = 32;
		const height = 32;
		const source = transparentLayer(width, height);
		const dabs = Array.from({ length: 30 }, () => ({ x: 16, y: 16, pressure: 1, size: 15, t: 0 }));

		const result = compositeDabs({
			width,
			height,
			layer: source,
			dabs,
			settings: { ...BASE_SETTINGS, size: 15, hardness: 1, flow: 0.2, opacity: 0.35 },
			color: [20, 40, 60, 255],
		});

		const centerIndex = 16 * width + 16;
		expect(result.strokeAlpha[centerIndex]).toBeLessThanOrEqual(0.35);
		expect(result.strokeAlpha[centerIndex]).toBeCloseTo(0.35, 6);
		expect(pixelAlpha(result.layer, width, 16, 16)).toBeLessThanOrEqual(Math.ceil(0.35 * 255));
		expect(pixelAlpha(result.layer, width, 16, 16)).toBeGreaterThan(0);
		expect(pixelAlpha(source, width, 16, 16)).toBe(0);
	});

	it("clips out-of-bounds dabs and leaves untouched pixels transparent", () => {
		const width = 8;
		const height = 8;
		const result = compositeDabs({
			width,
			height,
			layer: transparentLayer(width, height),
			dabs: [{ x: -1, y: -1, pressure: 1, size: 6, t: 0 }],
			settings: { ...BASE_SETTINGS, size: 6 },
		});

		expect(pixelAlpha(result.layer, width, 0, 0)).toBeGreaterThan(0);
		expect(pixelAlpha(result.layer, width, 7, 7)).toBe(0);
	});

	it("uses pointer pressure as flow strength without changing spacing semantics", () => {
		const width = 16;
		const height = 16;
		const lowPressure: BrushDab = { x: 8, y: 8, pressure: 0.25, size: 7, t: 0 };
		const fullPressure: BrushDab = { x: 8, y: 8, pressure: 1, size: 7, t: 0 };
		const settings = { ...BASE_SETTINGS, size: 7, flow: 0.8, opacity: 1 };

		const low = compositeDabs({ width, height, layer: transparentLayer(width, height), dabs: [lowPressure], settings });
		const full = compositeDabs({ width, height, layer: transparentLayer(width, height), dabs: [fullPressure], settings });

		expect(pixelAlpha(low.layer, width, 8, 8)).toBeLessThan(pixelAlpha(full.layer, width, 8, 8));
		expect(low.strokeAlpha[8 * width + 8]).toBeCloseTo(full.strokeAlpha[8 * width + 8] * 0.25, 5);
	});

	it("rejects RGBA buffers that do not match the declared layer size", () => {
		expect(() =>
			compositeDabs({
				width: 4,
				height: 4,
				layer: new Uint8ClampedArray(4),
				dabs: [],
				settings: BASE_SETTINGS,
			}),
		).toThrow(/expected 64 RGBA bytes/);
	});
});

function maxAbsY(dabs: readonly BrushDab[]): number {
	return Math.max(...dabs.map((dab) => Math.abs(dab.y)));
}
