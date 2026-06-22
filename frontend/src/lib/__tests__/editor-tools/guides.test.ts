import { describe, expect, it } from "vitest";
import { emptyGuideSet, snap, type GuideSet, type Point, type SnapBounds } from "$lib/editor-tools/guides.ts";

const bounds: SnapBounds = { left: 0, top: 0, width: 1000, height: 800 };

const guides: GuideSet = {
	vertical: [
		{ id: "v-100", orientation: "vertical", position: 100 },
		{ id: "v-240", orientation: "vertical", position: 240 },
	],
	horizontal: [
		{ id: "h-80", orientation: "horizontal", position: 80 },
		{ id: "h-220", orientation: "horizontal", position: 220 },
	],
};

describe("snap guide thresholds", () => {
	it("snaps to a guide at zero distance, inside threshold, and exactly on threshold", () => {
		const cases: Array<{
			name: string;
			point: Point;
			threshold: number;
			expectedX: number;
			expectedDelta: number;
			expectedDistance: number;
		}> = [
			{
				name: "same coordinate",
				point: { x: 100, y: 333 },
				threshold: 4,
				expectedX: 100,
				expectedDelta: 0,
				expectedDistance: 0,
			},
			{
				name: "inside threshold before guide",
				point: { x: 96.5, y: 333 },
				threshold: 4,
				expectedX: 100,
				expectedDelta: 3.5,
				expectedDistance: 3.5,
			},
			{
				name: "exact threshold after guide",
				point: { x: 104, y: 333 },
				threshold: 4,
				expectedX: 100,
				expectedDelta: -4,
				expectedDistance: 4,
			},
		];

		for (const testCase of cases) {
			const result = snap(testCase.point, { guides, bounds, threshold: testCase.threshold });

			expect(result.point, testCase.name).toEqual({ x: testCase.expectedX, y: testCase.point.y });
			expect(result.matches, testCase.name).toEqual([
				{
					axis: "x",
					source: "guide",
					position: 100,
					delta: testCase.expectedDelta,
					distance: testCase.expectedDistance,
					guideId: "v-100",
					orientation: "vertical",
				},
			]);
		}
	});

	it("does not snap to a guide just outside the configured threshold", () => {
		const result = snap({ x: 95.99, y: 333 }, { guides, bounds, threshold: 4 });

		expect(result).toEqual({
			point: { x: 95.99, y: 333 },
			matches: [],
		});
	});

	it("snaps x and y independently when only one axis is close enough", () => {
		const horizontalOnly = snap({ x: 112, y: 82.25 }, { guides, bounds, threshold: 3 });
		const verticalOnly = snap({ x: 237.5, y: 213 }, { guides, bounds, threshold: 3 });

		expect(horizontalOnly.point).toEqual({ x: 112, y: 80 });
		expect(horizontalOnly.matches).toEqual([
			{
				axis: "y",
				source: "guide",
				position: 80,
				delta: -2.25,
				distance: 2.25,
				guideId: "h-80",
				orientation: "horizontal",
			},
		]);
		expect(verticalOnly.point).toEqual({ x: 240, y: 213 });
		expect(verticalOnly.matches).toEqual([
			{
				axis: "x",
				source: "guide",
				position: 240,
				delta: 2.5,
				distance: 2.5,
				guideId: "v-240",
				orientation: "vertical",
			},
		]);
	});

	it("chooses the nearest guide and resolves equal guide distances by lower position", () => {
		const tieGuides: GuideSet = {
			vertical: [
				{ id: "v-left", orientation: "vertical", position: 90 },
				{ id: "v-right", orientation: "vertical", position: 110 },
			],
			horizontal: [],
		};

		expect(snap({ x: 104, y: 333 }, { guides: tieGuides, bounds, threshold: 20 }).matches[0]).toMatchObject({
			source: "guide",
			position: 110,
			guideId: "v-right",
			distance: 6,
		});
		expect(snap({ x: 100, y: 333 }, { guides: tieGuides, bounds, threshold: 20 }).matches[0]).toMatchObject({
			source: "guide",
			position: 90,
			guideId: "v-left",
			distance: 10,
		});
	});

	it("prefers an explicit guide over bounds and grid when snap distances tie", () => {
		const tieGuides: GuideSet = {
			vertical: [{ id: "v-right-edge", orientation: "vertical", position: 100 }],
			horizontal: [],
		};

		const result = snap(
			{ x: 102, y: 333 },
			{
				guides: tieGuides,
				bounds: { left: 0, top: 0, width: 100, height: 800 },
				gridSize: 50,
				threshold: 2,
			},
		);

		expect(result.point).toEqual({ x: 100, y: 333 });
		expect(result.matches).toEqual([
			{
				axis: "x",
				source: "guide",
				position: 100,
				delta: -2,
				distance: 2,
				guideId: "v-right-edge",
				orientation: "vertical",
			},
		]);
	});

	it("treats a negative threshold as exact-only snapping", () => {
		expect(snap({ x: 99.999, y: 220 }, { guides, bounds, threshold: -3 })).toEqual({
			point: { x: 99.999, y: 220 },
			matches: [
				{
					axis: "y",
					source: "guide",
					position: 220,
					delta: 0,
					distance: 0,
					guideId: "h-220",
					orientation: "horizontal",
				},
			],
		});
	});

	it("ignores invalid guide/bounds/grid inputs instead of inventing a snap target", () => {
		const invalidGuides: GuideSet = {
			vertical: [{ id: "bad-v", orientation: "vertical", position: Number.NaN }],
			horizontal: [{ id: "bad-h", orientation: "horizontal", position: Number.POSITIVE_INFINITY }],
		};

		expect(
			snap(
				{ x: 43, y: 57 },
				{
					guides: invalidGuides,
					bounds: { left: Number.NaN, top: 0, width: -1, height: 100 },
					gridSize: Number.NaN,
					threshold: 20,
				},
			),
		).toEqual({
			point: { x: 43, y: 57 },
			matches: [],
		});
		expect(snap({ x: 43, y: 57 }, { guides: emptyGuideSet(), bounds, gridSize: 10, threshold: 3 }).point).toEqual({
			x: 40,
			y: 60,
		});
	});
});
