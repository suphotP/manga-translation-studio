import { describe, expect, it } from "vitest";
import {
	ANNOTATION_PIN_REGION_SIZE,
	annotationPinLocalPoint,
	annotationToImageRegion,
	annotationToNormalizedRegion,
	buildAnnotation,
	clamp01,
	freehandPolylinePoints,
	openAnnotationCount,
	pageAnnotations,
	pointerToNormalized,
	pointsBounds,
} from "$lib/project/review-annotations.ts";
import type { ProjectComment, ReviewAnnotation } from "$lib/types.ts";

function comment(overrides: Partial<ProjectComment>): ProjectComment {
	return {
		id: "c1",
		pageIndex: 0,
		body: "note",
		author: "tester",
		status: "open",
		createdAt: "2026-06-01T00:00:00.000Z",
		updatedAt: "2026-06-01T00:00:00.000Z",
		...overrides,
	};
}

const sampleAnnotation: ReviewAnnotation = { shape: "circle", x: 0.1, y: 0.2, w: 0.3, h: 0.4 };

describe("pin edge coordinates (codex #386 P1)", () => {
	const pin = (x: number, y: number): ReviewAnnotation => ({ shape: "pin", x, y, w: 0, h: 0 });

	it("never overflows normalized bounds at any corner/edge", () => {
		for (const [x, y] of [
			[0, 0],
			[1, 1],
			[1, 0],
			[0, 1],
			[0.5, 0.5],
			[0.99, 0.02],
		] as const) {
			const r = annotationToNormalizedRegion(pin(x, y));
			expect(r.x).toBeGreaterThanOrEqual(0);
			expect(r.y).toBeGreaterThanOrEqual(0);
			expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
			expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9);
			expect(r.w).toBeCloseTo(ANNOTATION_PIN_REGION_SIZE * 2);
			expect(r.h).toBeCloseTo(ANNOTATION_PIN_REGION_SIZE * 2);
		}
	});

	it("renders the pin marker at its TRUE point (matches the review reader), even when clamped", () => {
		// Interior pin → box center (50,50).
		const interior = annotationPinLocalPoint(pin(0.5, 0.5));
		expect(interior.cx).toBeCloseTo(50);
		expect(interior.cy).toBeCloseTo(50);
		// Top-left corner → marker at the box's top-left (true point 0,0), not center.
		const topLeft = annotationPinLocalPoint(pin(0, 0));
		expect(topLeft.cx).toBeCloseTo(0);
		expect(topLeft.cy).toBeCloseTo(0);
		// Bottom-right corner → marker at the box's bottom-right (true point 1,1).
		const bottomRight = annotationPinLocalPoint(pin(1, 1));
		expect(bottomRight.cx).toBeCloseTo(100);
		expect(bottomRight.cy).toBeCloseTo(100);
	});
});

describe("review-annotations", () => {
	describe("clamp01 / pointerToNormalized", () => {
		it("clamps into [0,1]", () => {
			expect(clamp01(-0.5)).toBe(0);
			expect(clamp01(1.7)).toBe(1);
			expect(clamp01(0.42)).toBeCloseTo(0.42);
			expect(clamp01(Number.NaN)).toBe(0);
		});

		it("normalizes a pointer to the rendered box and clamps out-of-box", () => {
			expect(pointerToNormalized(50, 75, 100, 300)).toEqual({ x: 0.5, y: 0.25 });
			expect(pointerToNormalized(-10, 400, 100, 300)).toEqual({ x: 0, y: 1 });
		});
	});

	describe("pointsBounds", () => {
		it("returns a zero box for no points", () => {
			expect(pointsBounds([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
		});
		it("computes the bounding box of a path", () => {
			expect(pointsBounds([
				{ x: 0.2, y: 0.3 },
				{ x: 0.5, y: 0.1 },
				{ x: 0.4, y: 0.6 },
			])).toEqual({ x: 0.2, y: 0.1, w: expect.closeTo(0.3), h: expect.closeTo(0.5) });
		});
	});

	describe("buildAnnotation", () => {
		it("builds a pin anchored at start with a zero box", () => {
			const a = buildAnnotation("pin", { x: 0.4, y: 0.6 }, { x: 0.9, y: 0.9 });
			expect(a).toMatchObject({ shape: "pin", x: 0.4, y: 0.6, w: 0, h: 0 });
		});

		it("builds a circle/rect from the drag bounding box", () => {
			const a = buildAnnotation("rect", { x: 0.6, y: 0.7 }, { x: 0.2, y: 0.3 });
			expect(a).toMatchObject({ shape: "rect", x: 0.2, y: 0.3 });
			expect(a?.w).toBeCloseTo(0.4);
			expect(a?.h).toBeCloseTo(0.4);
		});

		it("rejects a degenerate (too-small) non-pin drag", () => {
			expect(buildAnnotation("circle", { x: 0.5, y: 0.5 }, { x: 0.5005, y: 0.5005 })).toBeNull();
		});

		it("builds a freehand mark carrying the normalized path + bounds", () => {
			const points = [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.2 }, { x: 0.3, y: 0.5 }];
			const a = buildAnnotation("freehand", points[0], points[2], { points });
			expect(a?.shape).toBe("freehand");
			expect(a?.points).toHaveLength(3);
			expect(a).toMatchObject({ x: 0.1, y: 0.1 });
		});

		it("rejects a freehand with fewer than 2 points", () => {
			expect(buildAnnotation("freehand", { x: 0, y: 0 }, { x: 0, y: 0 }, { points: [{ x: 0, y: 0 }] })).toBeNull();
		});
	});

	describe("freehandPolylinePoints", () => {
		it("scales normalized points to the px box", () => {
			const a: ReviewAnnotation = { shape: "freehand", x: 0, y: 0, w: 1, h: 1, points: [{ x: 0, y: 0 }, { x: 0.5, y: 1 }] };
			expect(freehandPolylinePoints(a, 200, 100)).toBe("0.00,0.00 100.00,100.00");
		});
		it("returns empty for an annotation with no points", () => {
			expect(freehandPolylinePoints(sampleAnnotation, 100, 100)).toBe("");
		});
	});

	describe("pageAnnotations / openAnnotationCount", () => {
		const comments: ProjectComment[] = [
			comment({ id: "a", pageIndex: 0, annotation: sampleAnnotation, createdAt: "2026-06-01T00:00:02.000Z" }),
			comment({ id: "b", pageIndex: 0, annotation: { ...sampleAnnotation, shape: "pin" }, createdAt: "2026-06-01T00:00:01.000Z" }),
			comment({ id: "c", pageIndex: 1, annotation: sampleAnnotation }),
			comment({ id: "d", pageIndex: 0 }), // no annotation
			comment({ id: "e", pageIndex: 0, annotation: sampleAnnotation, status: "resolved", createdAt: "2026-06-01T00:00:03.000Z" }),
		];

		it("returns only annotated comments for a page, oldest-first", () => {
			const items = pageAnnotations(comments, 0);
			expect(items.map((i) => i.comment.id)).toEqual(["b", "a", "e"]);
		});

		it("can hide resolved marks", () => {
			const items = pageAnnotations(comments, 0, { openOnly: true });
			expect(items.map((i) => i.comment.id)).toEqual(["b", "a"]);
		});

		it("counts only open annotations on the page", () => {
			expect(openAnnotationCount(comments, 0)).toBe(2);
			expect(openAnnotationCount(comments, 1)).toBe(1);
			expect(openAnnotationCount(comments, 2)).toBe(0);
		});
	});

	describe("annotationToNormalizedRegion", () => {
		it("gives a pin a centered min tappable box", () => {
			const r = annotationToNormalizedRegion({ shape: "pin", x: 0.5, y: 0.5, w: 0, h: 0 });
			const half = ANNOTATION_PIN_REGION_SIZE;
			expect(r).toEqual({ x: 0.5 - half, y: 0.5 - half, w: half * 2, h: half * 2 });
		});

		it("clamps a pin at an edge so the box stays fully in [0,1] (no overflow)", () => {
			const r = annotationToNormalizedRegion({ shape: "pin", x: 0, y: 1, w: 0, h: 0 });
			expect(r.x).toBe(0);
			// Origin clamps to 1 - size (not 1 - half) so y + h === 1 exactly, no overflow.
			expect(r.y).toBe(1 - ANNOTATION_PIN_REGION_SIZE * 2);
			expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9);
		});

		it("uses circle/rect bounds and floors tiny marks to a min size", () => {
			const big = annotationToNormalizedRegion({ shape: "rect", x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
			expect(big).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
			const tiny = annotationToNormalizedRegion({ shape: "circle", x: 0.1, y: 0.1, w: 0.001, h: 0.001 });
			expect(tiny.w).toBe(ANNOTATION_PIN_REGION_SIZE * 2);
			expect(tiny.h).toBe(ANNOTATION_PIN_REGION_SIZE * 2);
		});
	});

	describe("annotationToImageRegion", () => {
		it("scales a normalized region into image-pixel space", () => {
			const r = annotationToImageRegion({ shape: "rect", x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, 1000, 2000);
			expect(r).toEqual({ x: 100, y: 400, w: 300, h: 800 });
		});

		it("floors width/height at 1px and tolerates zero image dims", () => {
			const r = annotationToImageRegion({ shape: "pin", x: 0.5, y: 0.5, w: 0, h: 0 }, 0, 0);
			expect(r.w).toBeGreaterThanOrEqual(1);
			expect(r.h).toBeGreaterThanOrEqual(1);
		});
	});
});
