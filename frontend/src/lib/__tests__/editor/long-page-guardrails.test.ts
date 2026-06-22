// W3.15 — long-page guardrail geometry + policy tests.
// Pure functions only (no Fabric / DOM), mirroring editor.test.ts conventions.

import { describe, it, expect } from "vitest";
import {
	canUseMultiPageMode,
	clampBrushPointerToSegment,
	clipPointToSegment,
	computePageBoundaryLines,
	computeSegmentBounds,
	isPointInSegment,
	normalizeBoundaryFractions,
	pageClipToastMessage,
	pageSegmentCount,
	segmentIndexForSceneY,
} from "$lib/editor/long-page-guardrails.ts";
import type { RoleCapabilityFlags } from "$lib/stores/auth.svelte.ts";

const BOUNDS = { left: 100, top: 200, width: 800, height: 4000 };

function capabilities(overrides: Partial<RoleCapabilityFlags> = {}): RoleCapabilityFlags {
	return {
		canTranslate: false,
		canClean: false,
		canTypeset: false,
		canReviewQC: false,
		canManageMembers: false,
		canManageBilling: false,
		canExport: false,
		canImport: false,
		canGenerateAI: false,
		canManageProjects: false,
		...overrides,
	};
}

describe("normalizeBoundaryFractions", () => {
	it("sorts, dedupes, and drops out-of-range values", () => {
		expect(normalizeBoundaryFractions([0.75, 0.25, 0.25, 0, 1, -0.1, 1.2, Number.NaN]))
			.toEqual([0.25, 0.75]);
	});

	it("returns [] for empty / nullish input", () => {
		expect(normalizeBoundaryFractions([])).toEqual([]);
		expect(normalizeBoundaryFractions(null)).toEqual([]);
		expect(normalizeBoundaryFractions(undefined)).toEqual([]);
	});

	it("collapses near-duplicate cuts that would make a zero-height page", () => {
		expect(normalizeBoundaryFractions([0.5, 0.5000001])).toEqual([0.5]);
	});
});

describe("pageSegmentCount", () => {
	it("is cuts + 1 (single page when no cuts)", () => {
		expect(pageSegmentCount([])).toBe(1);
		expect(pageSegmentCount([0.5])).toBe(2);
		expect(pageSegmentCount([0.25, 0.5, 0.75])).toBe(4);
	});
});

describe("computePageBoundaryLines", () => {
	it("places internal cut lines at the exact scene-Y of each fraction (no off-by-one)", () => {
		const lines = computePageBoundaryLines(BOUNDS, [0.25, 0.5]);
		expect(lines).toEqual([
			{ pageNumber: 1, sceneY: 200 + 0.25 * 4000, isImageEdge: false }, // 1200
			{ pageNumber: 2, sceneY: 200 + 0.5 * 4000, isImageEdge: false }, // 2200
			{ pageNumber: 3, sceneY: 200 + 4000, isImageEdge: true }, // 4200 bottom edge
		]);
	});

	it("draws only the bottom edge for a single page (no internal cuts)", () => {
		const lines = computePageBoundaryLines(BOUNDS, []);
		expect(lines).toEqual([{ pageNumber: 1, sceneY: 4200, isImageEdge: true }]);
	});

	it("returns [] when bounds are unusable", () => {
		expect(computePageBoundaryLines({ left: 0, top: 0, width: 0, height: 0 }, [0.5])).toEqual([]);
	});
});

describe("computeSegmentBounds", () => {
	it("returns the full image bounds for the only segment of a single page", () => {
		expect(computeSegmentBounds(BOUNDS, [], 0)).toEqual({
			pageNumber: 1,
			left: 100,
			top: 200,
			width: 800,
			height: 4000,
		});
	});

	it("splits a long page into exact, gapless, non-overlapping segments", () => {
		const top = computeSegmentBounds(BOUNDS, [0.5], 0)!;
		const bottom = computeSegmentBounds(BOUNDS, [0.5], 1)!;
		expect(top).toEqual({ pageNumber: 1, left: 100, top: 200, width: 800, height: 2000 });
		expect(bottom).toEqual({ pageNumber: 2, left: 100, top: 2200, width: 800, height: 2000 });
		// No off-by-one: top.bottom === bottom.top exactly.
		expect(top.top + top.height).toBe(bottom.top);
	});

	it("clamps an out-of-range index to the nearest valid segment", () => {
		expect(computeSegmentBounds(BOUNDS, [0.5], 9)!.pageNumber).toBe(2);
		expect(computeSegmentBounds(BOUNDS, [0.5], -3)!.pageNumber).toBe(1);
	});
});

describe("segmentIndexForSceneY", () => {
	const fractions = [0.25, 0.5];
	it("maps scene-Y into the correct 0-based segment", () => {
		expect(segmentIndexForSceneY(BOUNDS, fractions, 200)).toBe(0); // top
		expect(segmentIndexForSceneY(BOUNDS, fractions, 1199)).toBe(0); // just above cut 1 (1200)
		expect(segmentIndexForSceneY(BOUNDS, fractions, 1200)).toBe(1); // exactly on cut -> below page
		expect(segmentIndexForSceneY(BOUNDS, fractions, 2200)).toBe(2); // exactly on cut 2 (2200)
		expect(segmentIndexForSceneY(BOUNDS, fractions, 4200)).toBe(2); // bottom edge stays last page
	});

	it("is always 0 for a single page", () => {
		expect(segmentIndexForSceneY(BOUNDS, [], 4000)).toBe(0);
	});
});

describe("clipPointToSegment", () => {
	const segment = { left: 100, top: 2200, width: 800, height: 2000 }; // page 2 of [0.5]

	it("passes a point that is inside the segment unchanged + unclipped", () => {
		const result = clipPointToSegment(segment, { x: 400, y: 3000 });
		expect(result).toEqual({ point: { x: 400, y: 3000 }, clipped: false });
	});

	it("clamps + flags a point that crosses the page boundary (above the segment)", () => {
		const result = clipPointToSegment(segment, { x: 400, y: 1000 });
		expect(result.point).toEqual({ x: 400, y: 2200 });
		expect(result.clipped).toBe(true);
	});

	it("clamps + flags a point below the segment", () => {
		const result = clipPointToSegment(segment, { x: 400, y: 9999 });
		expect(result.point).toEqual({ x: 400, y: 4200 });
		expect(result.clipped).toBe(true);
	});

	it("clamps X to the page edge WITHOUT flagging it as a cross-page clip", () => {
		const result = clipPointToSegment(segment, { x: -50, y: 3000 });
		expect(result.point).toEqual({ x: 100, y: 3000 });
		expect(result.clipped).toBe(false);
	});
});

describe("clampBrushPointerToSegment (footprint-aware)", () => {
	const segment = { left: 100, top: 2200, width: 800, height: 2000 }; // page 2, y in [2200,4200]

	it("holds the brush CENTRE back by the radius so the disc never crosses a cut", () => {
		// Centre at 2210 with radius 30 would paint up to y=2180 (past the 2200 cut).
		const result = clampBrushPointerToSegment(segment, { x: 400, y: 2210 }, 30);
		expect(result.point.y).toBe(2230); // clamped to top + radius
		expect(result.clipped).toBe(true);
		expect(result.outsideHorizontally).toBe(false);
	});

	it("clamps the centre off the bottom edge by the radius too", () => {
		const result = clampBrushPointerToSegment(segment, { x: 400, y: 4195 }, 30);
		expect(result.point.y).toBe(4170); // bottom (4200) - radius
		expect(result.clipped).toBe(true);
	});

	it("does not flag a clip when the whole footprint stays inside the page", () => {
		const result = clampBrushPointerToSegment(segment, { x: 400, y: 3000 }, 30);
		expect(result.point).toEqual({ x: 400, y: 3000 });
		expect(result.clipped).toBe(false);
		expect(result.outsideHorizontally).toBe(false);
	});

	it("pins the centre to the segment mid-line when the page is thinner than the brush", () => {
		const thin = { left: 100, top: 2200, width: 800, height: 40 };
		const result = clampBrushPointerToSegment(thin, { x: 400, y: 2400 }, 50);
		expect(result.point.y).toBe(2220); // mid-line of [2200,2240]
	});

	it("reports a horizontal off-page miss instead of clamping X into a paint stroke", () => {
		// Footprint entirely left of the page edge (x + r < left).
		const result = clampBrushPointerToSegment(segment, { x: 50, y: 3000 }, 30);
		expect(result.outsideHorizontally).toBe(true);
	});

	it("does not treat a footprint that merely straddles the side edge as a miss", () => {
		const result = clampBrushPointerToSegment(segment, { x: 90, y: 3000 }, 30);
		expect(result.outsideHorizontally).toBe(false);
		expect(result.point.x).toBe(100); // clamped onto the edge, still a real stroke
	});
});

describe("isPointInSegment", () => {
	const segment = { left: 100, top: 200, width: 800, height: 2000 };
	it("treats edges as inside", () => {
		expect(isPointInSegment(segment, { x: 100, y: 200 })).toBe(true);
		expect(isPointInSegment(segment, { x: 900, y: 2200 })).toBe(true);
		expect(isPointInSegment(segment, { x: 901, y: 2200 })).toBe(false);
		expect(isPointInSegment(segment, { x: 500, y: 2201 })).toBe(false);
	});
});

describe("canUseMultiPageMode (role gate)", () => {
	it("allows Cleaner and Typesetter capabilities", () => {
		expect(canUseMultiPageMode(capabilities({ canClean: true }))).toBe(true);
		expect(canUseMultiPageMode(capabilities({ canTypeset: true }))).toBe(true);
		expect(canUseMultiPageMode(capabilities({ canClean: true, canTypeset: true }))).toBe(true);
	});

	it("denies translator / QC / viewer / anonymous", () => {
		expect(canUseMultiPageMode(capabilities({ canTranslate: true }))).toBe(false);
		expect(canUseMultiPageMode(capabilities({ canReviewQC: true }))).toBe(false);
		expect(canUseMultiPageMode(capabilities({ canExport: true }))).toBe(false);
		expect(canUseMultiPageMode(capabilities())).toBe(false);
		expect(canUseMultiPageMode(null)).toBe(false);
		expect(canUseMultiPageMode(undefined)).toBe(false);
	});
});

describe("pageClipToastMessage", () => {
	it("names the page the stroke was clipped at and points at multi-page mode", () => {
		expect(pageClipToastMessage(2)).toBe(
			"tool clipped at page 2 — switch to multi-page mode to edit across pages",
		);
	});
});
