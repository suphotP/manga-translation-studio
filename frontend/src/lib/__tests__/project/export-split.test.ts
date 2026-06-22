// Webtoon split-on-export planning: both selection modes (height-per-piece /
// piece-count) with the ENFORCED minimums — ≥EXPORT_SPLIT_MIN_HEIGHT px per
// slice (smaller requests clamp UP → fewer pieces) and ≤EXPORT_SPLIT_MAX_PIECES
// per page. planExportSliceHeight is the pure math the zip exporter consumes.

import { describe, expect, it } from "vitest";
import {
	EXPORT_SPLIT_MAX_PIECES,
	EXPORT_SPLIT_MIN_HEIGHT,
	planExportSliceBoundaries,
	planExportSliceHeight,
} from "$lib/project/page-export.js";

describe("planExportSliceHeight", () => {
	it("returns null when no split is requested", () => {
		expect(planExportSliceHeight(10000, undefined)).toBeNull();
	});

	it("height mode: uses the requested height when it is above the minimum", () => {
		expect(planExportSliceHeight(10000, { mode: "height", heightPerPiece: 2000 })).toBe(2000);
	});

	it("height mode: clamps a too-small request UP to the minimum slice height", () => {
		expect(planExportSliceHeight(10000, { mode: "height", heightPerPiece: 50 })).toBe(EXPORT_SPLIT_MIN_HEIGHT);
	});

	it("height mode: rejects invalid values", () => {
		expect(planExportSliceHeight(10000, { mode: "height", heightPerPiece: 0 })).toBeNull();
		expect(planExportSliceHeight(10000, { mode: "height" })).toBeNull();
		expect(planExportSliceHeight(10000, { mode: "height", heightPerPiece: Number.NaN })).toBeNull();
	});

	it("count mode: divides the page into the requested pieces", () => {
		// 10000px at 10 pieces → 1000px per slice.
		expect(planExportSliceHeight(10000, { mode: "count", pieceCount: 10 })).toBe(1000);
	});

	it("count mode: the minimum slice height wins over a too-high count (fewer pieces than asked)", () => {
		// 1000px at 50 pieces would be 20px slices — clamped to the 200px floor → 5 pieces.
		const sliceHeight = planExportSliceHeight(1000, { mode: "count", pieceCount: 50 });
		expect(sliceHeight).toBe(EXPORT_SPLIT_MIN_HEIGHT);
		expect(Math.ceil(1000 / sliceHeight!)).toBe(5);
	});

	it("count mode: clamps the requested count to the hard per-page ceiling", () => {
		// A pathological count cannot exceed EXPORT_SPLIT_MAX_PIECES slices.
		const tallPage = EXPORT_SPLIT_MIN_HEIGHT * 1000;
		const sliceHeight = planExportSliceHeight(tallPage, { mode: "count", pieceCount: 9999 });
		expect(sliceHeight).not.toBeNull();
		expect(Math.ceil(tallPage / sliceHeight!)).toBeLessThanOrEqual(EXPORT_SPLIT_MAX_PIECES);
	});

	it("count mode: a count of 1 or less means no split", () => {
		expect(planExportSliceHeight(10000, { mode: "count", pieceCount: 1 })).toBeNull();
		expect(planExportSliceHeight(10000, { mode: "count", pieceCount: 0 })).toBeNull();
	});

	it("returns null when one slice would cover the whole page (short page stays whole)", () => {
		expect(planExportSliceHeight(1500, { mode: "height", heightPerPiece: 2000 })).toBeNull();
		expect(planExportSliceHeight(150, { mode: "count", pieceCount: 2 })).toBeNull();
	});

	it("height mode also respects the absolute piece ceiling on extreme pages", () => {
		const extreme = EXPORT_SPLIT_MIN_HEIGHT * (EXPORT_SPLIT_MAX_PIECES * 4);
		const sliceHeight = planExportSliceHeight(extreme, { mode: "height", heightPerPiece: EXPORT_SPLIT_MIN_HEIGHT });
		expect(Math.ceil(extreme / sliceHeight!)).toBeLessThanOrEqual(EXPORT_SPLIT_MAX_PIECES);
	});
});

describe("planExportSliceBoundaries", () => {
	it("folds a runt tail into the previous slice so every slice honors the minimum", () => {
		// 1001px at 201px chunks: naive = [201,201,201,201,197] — the 197px tail
		// violates the advertised ≥200px minimum and is folded into the last slice.
		const heights = planExportSliceBoundaries(1001, 201);
		expect(heights).toEqual([201, 201, 201, 398]);
		expect(heights.every((h) => h >= EXPORT_SPLIT_MIN_HEIGHT)).toBe(true);
		expect(heights.reduce((a, b) => a + b, 0)).toBe(1001);
	});

	it("never emits a sliver tail in height mode", () => {
		// 4001px at 2000px chunks → naive tail of 1px; folded into the last slice.
		const heights = planExportSliceBoundaries(4001, 2000);
		expect(heights).toEqual([2000, 2001]);
	});

	it("exact multiples stay untouched", () => {
		expect(planExportSliceBoundaries(6000, 2000)).toEqual([2000, 2000, 2000]);
	});

	it("a single-slice page passes through", () => {
		expect(planExportSliceBoundaries(150, 2000)).toEqual([150]);
	});
});
