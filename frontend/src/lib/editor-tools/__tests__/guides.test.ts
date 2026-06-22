import { describe, expect, it } from "vitest";
import {
	addGuide,
	buildRulerTicks,
	deleteGuide,
	dragGuide,
	emptyGuideSet,
	findSmartSpacingGuides,
	snap,
	type GuideSet,
	type Rect,
} from "$lib/editor-tools/guides.ts";

describe("guide set operations", () => {
	it("adds vertical and horizontal guides immutably and keeps each axis sorted", () => {
		const initial = emptyGuideSet();
		const withVertical = addGuide(initial, { id: "v2", orientation: "vertical", position: 200 });
		const result = addGuide(addGuide(withVertical, { id: "h1", orientation: "horizontal", position: 80 }), {
			id: "v1",
			orientation: "vertical",
			position: 100,
		});

		expect(initial).toEqual({ vertical: [], horizontal: [] });
		expect(withVertical).not.toBe(initial);
		expect(result.vertical.map((guide) => guide.id)).toEqual(["v1", "v2"]);
		expect(result.horizontal).toEqual([{ id: "h1", orientation: "horizontal", position: 80 }]);
	});

	it("replaces duplicate guide ids across axes so drag/delete remain unambiguous", () => {
		const set = addGuide(addGuide(emptyGuideSet(), { id: "shared", orientation: "vertical", position: 24 }), {
			id: "shared",
			orientation: "horizontal",
			position: 48,
		});

		expect(set).toEqual({
			vertical: [],
			horizontal: [{ id: "shared", orientation: "horizontal", position: 48 }],
		});
	});

	it("drags and deletes guides without mutating the original set", () => {
		const set = addGuide(addGuide(emptyGuideSet(), { id: "v1", orientation: "vertical", position: 100 }), {
			id: "h1",
			orientation: "horizontal",
			position: 50,
		});

		const dragged = dragGuide(set, "v1", 125.25);
		const deleted = deleteGuide(dragged, "h1");

		expect(set.vertical[0]).toEqual({ id: "v1", orientation: "vertical", position: 100 });
		expect(dragged.vertical[0]).toEqual({ id: "v1", orientation: "vertical", position: 125.25 });
		expect(deleted).toEqual({
			vertical: [{ id: "v1", orientation: "vertical", position: 125.25 }],
			horizontal: [],
		});
	});

	it("ignores unusable guide positions and unknown ids", () => {
		const set = addGuide(emptyGuideSet(), { id: "v1", orientation: "vertical", position: 100 });

		expect(addGuide(set, { id: "bad", orientation: "vertical", position: Number.NaN })).toBe(set);
		expect(dragGuide(set, "v1", Number.POSITIVE_INFINITY)).toBe(set);
		expect(dragGuide(set, "missing", 120)).toBe(set);
		expect(deleteGuide(set, "missing")).toBe(set);
	});
});

describe("snap", () => {
	const bounds = { left: 0, top: 0, width: 400, height: 300 };

	it("snaps x/y independently to explicit guides and returns highlight metadata", () => {
		const guides: GuideSet = {
			vertical: [{ id: "v-center", orientation: "vertical", position: 200 }],
			horizontal: [{ id: "h-baseline", orientation: "horizontal", position: 128 }],
		};

		const result = snap({ x: 196, y: 130 }, { guides, bounds, threshold: 5 });

		expect(result.point).toEqual({ x: 200, y: 128 });
		expect(result.matches).toEqual([
			{
				axis: "x",
				source: "guide",
				position: 200,
				delta: 4,
				distance: 4,
				guideId: "v-center",
				orientation: "vertical",
			},
			{
				axis: "y",
				source: "guide",
				position: 128,
				delta: -2,
				distance: 2,
				guideId: "h-baseline",
				orientation: "horizontal",
			},
		]);
	});

	it("snaps to bounds edges and centers when no closer guide is available", () => {
		const result = snap({ x: 398, y: 151 }, { guides: emptyGuideSet(), bounds, threshold: 3 });

		expect(result.point).toEqual({ x: 400, y: 150 });
		expect(result.matches).toEqual([
			{ axis: "x", source: "bounds", position: 400, delta: 2, distance: 2, boundsKind: "right" },
			{ axis: "y", source: "bounds", position: 150, delta: -1, distance: 1, boundsKind: "center-y" },
		]);
	});

	it("snaps to the nearest grid line only when gridSize is usable", () => {
		const result = snap({ x: 23, y: 41 }, { guides: emptyGuideSet(), bounds: invalidBounds(), gridSize: 10, threshold: 3 });
		const noGrid = snap({ x: 23, y: 41 }, { guides: emptyGuideSet(), bounds: invalidBounds(), gridSize: 0, threshold: 3 });

		expect(result.point).toEqual({ x: 20, y: 40 });
		expect(result.matches).toEqual([
			{ axis: "x", source: "grid", position: 20, delta: -3, distance: 3 },
			{ axis: "y", source: "grid", position: 40, delta: -1, distance: 1 },
		]);
		expect(noGrid).toEqual({ point: { x: 23, y: 41 }, matches: [] });
	});

	it("uses the closest target but prefers guide, bounds, then grid for exact ties", () => {
		const guides: GuideSet = {
			vertical: [{ id: "v-tie", orientation: "vertical", position: 100 }],
			horizontal: [],
		};

		const result = snap({ x: 102, y: 2 }, { guides, bounds: { left: 0, top: 0, width: 100, height: 100 }, gridSize: 4, threshold: 2 });

		expect(result.point).toEqual({ x: 100, y: 0 });
		expect(result.matches).toEqual([
			{
				axis: "x",
				source: "guide",
				position: 100,
				delta: -2,
				distance: 2,
				guideId: "v-tie",
				orientation: "vertical",
			},
			{ axis: "y", source: "bounds", position: 0, delta: -2, distance: 2, boundsKind: "top" },
		]);
	});

	it("does not snap outside the threshold and treats negative thresholds as exact-only", () => {
		const guides: GuideSet = {
			vertical: [{ id: "v1", orientation: "vertical", position: 100 }],
			horizontal: [{ id: "h1", orientation: "horizontal", position: 50 }],
		};

		expect(snap({ x: 94, y: 45 }, { guides, bounds, threshold: 5 })).toEqual({ point: { x: 94, y: 50 }, matches: [
			{
				axis: "y",
				source: "guide",
				position: 50,
				delta: 5,
				distance: 5,
				guideId: "h1",
				orientation: "horizontal",
			},
		] });
		expect(snap({ x: 99.5, y: 50 }, { guides, bounds, threshold: -1 })).toEqual({ point: { x: 99.5, y: 50 }, matches: [
			{
				axis: "y",
				source: "guide",
				position: 50,
				delta: 0,
				distance: 0,
				guideId: "h1",
				orientation: "horizontal",
			},
		] });
	});

	it("leaves non-finite points unchanged", () => {
		const point = { x: Number.NaN, y: 10 };
		expect(snap(point, { guides: emptyGuideSet(), bounds, gridSize: 10, threshold: 10 })).toEqual({ point, matches: [] });
	});
});

describe("buildRulerTicks", () => {
	it("builds major/minor ticks for the visible world range", () => {
		const model = buildRulerTicks({ start: 0, end: 120, zoom: 1 });

		expect(model.minorStep).toBe(10);
		expect(model.majorStep).toBe(50);
		expect(model.ticks.slice(0, 7)).toEqual([
			{ kind: "major", position: 0, label: "0" },
			{ kind: "minor", position: 10 },
			{ kind: "minor", position: 20 },
			{ kind: "minor", position: 30 },
			{ kind: "minor", position: 40 },
			{ kind: "major", position: 50, label: "50" },
			{ kind: "minor", position: 60 },
		]);
	});

	it("uses smaller world steps when zoomed in and larger steps when zoomed out", () => {
		const zoomedIn = buildRulerTicks({ start: 0, end: 40, zoom: 2 });
		const zoomedOut = buildRulerTicks({ start: 0, end: 400, zoom: 0.25 });

		expect(zoomedIn.minorStep).toBe(5);
		expect(zoomedIn.majorStep).toBe(25);
		expect(zoomedOut.minorStep).toBe(50);
		expect(zoomedOut.majorStep).toBe(250);
	});

	it("supports reversed and negative ranges", () => {
		const model = buildRulerTicks({ start: 15, end: -25, zoom: 1, minorPixelSpacing: 10, majorPixelSpacing: 20 });

		expect(model.ticks.map((tick) => tick.position)).toEqual([-20, -10, 0, 10]);
		expect(model.ticks.filter((tick) => tick.kind === "major")).toEqual([{ kind: "major", position: 0, label: "0" }]);
	});

	it("returns an empty model for invalid zoom or range inputs", () => {
		expect(buildRulerTicks({ start: 0, end: 100, zoom: 0 })).toEqual({ minorStep: 0, majorStep: 0, ticks: [] });
		expect(buildRulerTicks({ start: Number.NaN, end: 100, zoom: 1 })).toEqual({ minorStep: 0, majorStep: 0, ticks: [] });
	});
});

describe("findSmartSpacingGuides", () => {
	it("finds equal horizontal gaps between adjacent object bounds", () => {
		const rects: Rect[] = [
			{ id: "a", left: 0, top: 10, width: 20, height: 20 },
			{ id: "b", left: 35, top: 0, width: 20, height: 30 },
			{ id: "c", left: 70, top: 5, width: 20, height: 20 },
		];

		expect(findSmartSpacingGuides(rects, { tolerance: 0 })).toEqual([
			{
				axis: "x",
				distance: 15,
				gaps: [
					{ axis: "x", beforeId: "a", afterId: "b", from: 20, to: 35, distance: 15, crossStart: 0, crossEnd: 30 },
					{ axis: "x", beforeId: "b", afterId: "c", from: 55, to: 70, distance: 15, crossStart: 0, crossEnd: 30 },
				],
			},
		]);
	});

	it("finds equal vertical gaps within tolerance", () => {
		const rects: Rect[] = [
			{ id: "top", left: 0, top: 0, width: 40, height: 10 },
			{ id: "middle", left: 10, top: 20, width: 40, height: 10 },
			{ id: "bottom", left: 20, top: 40.2, width: 40, height: 10 },
		];

		const guides = findSmartSpacingGuides(rects, { tolerance: 0.25 });

		expect(guides).toHaveLength(1);
		expect(guides[0].axis).toBe("y");
		expect(guides[0].distance).toBe(10.1);
		expect(guides[0].gaps.map((gap) => [gap.beforeId, gap.afterId])).toEqual([
			["top", "middle"],
			["middle", "bottom"],
		]);
	});

	it("returns every equal pair when several adjacent gaps match", () => {
		const rects: Rect[] = [
			{ id: "a", left: 0, top: 0, width: 10, height: 10 },
			{ id: "b", left: 20, top: 0, width: 10, height: 10 },
			{ id: "c", left: 40, top: 0, width: 10, height: 10 },
			{ id: "d", left: 60, top: 0, width: 10, height: 10 },
		];

		const guides = findSmartSpacingGuides(rects, { tolerance: 0 }).filter((guide) => guide.axis === "x");

		expect(guides).toHaveLength(3);
		expect(guides.map((guide) => guide.gaps.map((gap) => `${gap.beforeId}-${gap.afterId}`))).toEqual([
			["a-b", "b-c"],
			["a-b", "c-d"],
			["b-c", "c-d"],
		]);
	});

	it("ignores overlapping or unusable rects and does not mutate the source list", () => {
		const rects: Rect[] = [
			{ id: "a", left: 0, top: 0, width: 20, height: 20 },
			{ id: "overlap", left: 10, top: 0, width: 20, height: 20 },
			{ id: "b", left: 40, top: 0, width: 20, height: 20 },
			{ id: "bad", left: 80, top: 0, width: Number.NaN, height: 20 },
			{ id: "c", left: 70, top: 0, width: 20, height: 20 },
		];
		const original = rects.map((rect) => ({ ...rect }));

		expect(findSmartSpacingGuides(rects, { tolerance: 0 })).toEqual([
			{
				axis: "x",
				distance: 10,
				gaps: [
					{ axis: "x", beforeId: "overlap", afterId: "b", from: 30, to: 40, distance: 10, crossStart: 0, crossEnd: 20 },
					{ axis: "x", beforeId: "b", afterId: "c", from: 60, to: 70, distance: 10, crossStart: 0, crossEnd: 20 },
				],
			},
		]);
		expect(rects).toEqual(original);
	});

	it("returns no guides when fewer than two comparable gaps exist", () => {
		expect(findSmartSpacingGuides([{ id: "only", left: 0, top: 0, width: 10, height: 10 }])).toEqual([]);
		expect(
			findSmartSpacingGuides([
				{ id: "a", left: 0, top: 0, width: 30, height: 10 },
				{ id: "b", left: 20, top: 0, width: 30, height: 10 },
				{ id: "c", left: 70, top: 0, width: 30, height: 10 },
			]),
		).toEqual([]);
	});
});

function invalidBounds() {
	return { left: Number.NaN, top: 0, width: 0, height: 0 };
}
