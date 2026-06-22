import { describe, expect, it } from "vitest";
import {
	fit,
	imageToScreen,
	nextZoomScale,
	pan,
	screenToImage,
	settlePan,
	shouldShowPixelGrid,
	zoomAt,
	zoomToNextStep,
	type Camera,
	type Point,
} from "$lib/editor-tools/viewport.ts";

function expectPointClose(actual: Point, expected: Point): void {
	expect(actual.x).toBeCloseTo(expected.x, 8);
	expect(actual.y).toBeCloseTo(expected.y, 8);
}

describe("viewport zoom around point", () => {
	it("keeps the same image coordinate under the cursor while zooming in", () => {
		const camera: Camera = { scale: 1.5, tx: -120, ty: 40 };
		const cursor = { x: 345.25, y: 256.75 };
		const anchoredImagePoint = screenToImage(camera, cursor);

		const next = zoomAt(camera, cursor, 2, { min: 0.25, max: 8 });

		expect(next.scale).toBe(3);
		expectPointClose(imageToScreen(next, anchoredImagePoint), cursor);
	});

	it("preserves the cursor anchor even when the requested zoom is clamped", () => {
		const camera: Camera = { scale: 1.25, tx: 18, ty: -36 };
		const cursor = { x: 120, y: 88 };
		const anchoredImagePoint = screenToImage(camera, cursor);

		const maxed = zoomAt(camera, cursor, 100, { min: 0.5, max: 4 });
		const mined = zoomAt(camera, cursor, 0.001, { min: 0.5, max: 4 });

		expect(maxed.scale).toBe(4);
		expect(mined.scale).toBe(0.5);
		expectPointClose(imageToScreen(maxed, anchoredImagePoint), cursor);
		expectPointClose(imageToScreen(mined, anchoredImagePoint), cursor);
	});
});

describe("viewport fit-to-screen", () => {
	it("contains a wide image inside the padded viewport and centers both axes", () => {
		const camera = fit(
			{ width: 1600, height: 1200 },
			{ width: 900, height: 700 },
			50,
		);

		expect(camera.scale).toBeCloseTo(0.5, 8);
		expect(camera.tx).toBeCloseTo(50, 8);
		expect(camera.ty).toBeCloseTo(50, 8);
	});

	it("contains a tall page by height while leaving horizontal room centered", () => {
		const camera = fit(
			{ width: 1000, height: 2000 },
			{ width: 800, height: 600 },
			40,
		);

		expect(camera.scale).toBeCloseTo(0.26, 8);
		expect(camera.tx).toBeCloseTo(270, 8);
		expect(camera.ty).toBeCloseTo(40, 8);
	});

	it("returns the identity camera for unusable image or viewport sizes", () => {
		expect(fit({ width: 0, height: 1200 }, { width: 900, height: 700 })).toEqual({ scale: 1, tx: 0, ty: 0 });
		expect(fit({ width: 1600, height: 1200 }, { width: 900, height: Number.NaN })).toEqual({ scale: 1, tx: 0, ty: 0 });
	});
});

describe("viewport pan clamping", () => {
	it("clamps large-image pan to strict bounds when rubber banding is disabled", () => {
		const options = {
			imageSize: { width: 1200, height: 900 },
			viewportSize: { width: 400, height: 300 },
			padding: 20,
			rubberBand: 0,
		};

		const clampedToMax = pan({ scale: 1, tx: -120, ty: -90 }, { x: 1000, y: 1000 }, options);
		const clampedToMin = pan(clampedToMax, { x: -2000, y: -2000 }, options);

		expect(clampedToMax).toEqual({ scale: 1, tx: 20, ty: 20 });
		expect(clampedToMin).toEqual({ scale: 1, tx: -820, ty: -620 });
	});

	it("settles a rubber-banded drag back to the non-rubber-band bounds", () => {
		const options = {
			imageSize: { width: 1000, height: 800 },
			viewportSize: { width: 400, height: 300 },
			padding: 20,
			rubberBand: 64,
		};

		const dragged = pan({ scale: 1, tx: 0, ty: 0 }, { x: 180, y: 140 }, options);
		const settled = settlePan(dragged, options);

		expect(dragged).toEqual({ scale: 1, tx: 84, ty: 84 });
		expect(settled).toEqual({ scale: 1, tx: 20, ty: 20 });
	});
});

describe("viewport pixel-perfect zoom levels", () => {
	it("walks the default zoom ladder before doubling beyond the last preset", () => {
		expect(nextZoomScale(0.25, "in")).toBe(0.5);
		expect(nextZoomScale(0.5, "in")).toBeCloseTo(0.66, 8);
		expect(nextZoomScale(0.66, "in")).toBe(1);
		expect(nextZoomScale(1, "in")).toBe(2);
		expect(nextZoomScale(2, "in")).toBe(4);
		expect(nextZoomScale(4, "in")).toBe(8);
		expect(nextZoomScale(8, "in")).toBe(16);
	});

	it("only shows the pixel grid above the exact 800 percent threshold", () => {
		expect(shouldShowPixelGrid(7.9999)).toBe(false);
		expect(shouldShowPixelGrid(8)).toBe(false);
		expect(shouldShowPixelGrid(8.0001)).toBe(true);
		expect(shouldShowPixelGrid({ scale: 16, tx: 0, ty: 0 })).toBe(true);
	});

	it("zooms to the next pixel-level step without shifting the cursor anchor", () => {
		const camera: Camera = { scale: 4, tx: -60, ty: 24 };
		const cursor = { x: 250, y: 160 };
		const anchoredImagePoint = screenToImage(camera, cursor);

		const next = zoomToNextStep(camera, cursor, "in");

		expect(next.scale).toBe(8);
		expect(shouldShowPixelGrid(next)).toBe(false);
		expectPointClose(imageToScreen(next, anchoredImagePoint), cursor);
	});
});
