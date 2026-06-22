import { describe, expect, it } from "vitest";
import {
	DEFAULT_RUBBER_BAND,
	fit,
	fillWidth,
	getPanBounds,
	imageRectToScreen,
	imageToScreen,
	nextZoomScale,
	pan,
	screenRectToImage,
	screenToImage,
	settlePan,
	shouldShowPixelGrid,
	zoomAt,
	zoomToNextStep,
	type Camera,
} from "$lib/editor-tools/viewport.js";

function expectPointClose(actual: { x: number; y: number }, expected: { x: number; y: number }) {
	expect(actual.x).toBeCloseTo(expected.x, 8);
	expect(actual.y).toBeCloseTo(expected.y, 8);
}

describe("viewport camera", () => {
	it("zooms around the cursor without moving the image point under it", () => {
		const camera: Camera = { scale: 2, tx: 10, ty: -20 };
		const cursor = { x: 140, y: 90 };
		const imagePoint = screenToImage(camera, cursor);

		const next = zoomAt(camera, cursor, 1.5);

		expect(next.scale).toBe(3);
		expectPointClose(imageToScreen(next, imagePoint), cursor);
	});

	it("clamps zoomAt to explicit limits while preserving the cursor anchor", () => {
		const camera: Camera = { scale: 1, tx: 12, ty: 18 };
		const cursor = { x: 80, y: 120 };
		const imagePoint = screenToImage(camera, cursor);

		const maxed = zoomAt(camera, cursor, 100, { min: 0.5, max: 4 });
		const mined = zoomAt(camera, cursor, 0.01, { min: 0.5, max: 4 });

		expect(maxed.scale).toBe(4);
		expect(mined.scale).toBe(0.5);
		expectPointClose(imageToScreen(maxed, imagePoint), cursor);
		expectPointClose(imageToScreen(mined, imagePoint), cursor);
	});

	it("falls back to a no-op zoom factor when the factor is not usable", () => {
		const camera: Camera = { scale: 1.25, tx: 8, ty: 9 };

		expect(zoomAt(camera, { x: 40, y: 50 }, Number.NaN)).toEqual(camera);
		expect(zoomAt(camera, { x: 40, y: 50 }, -2)).toEqual(camera);
	});

	it("fits an image inside the padded viewport and centers the result", () => {
		const camera = fit(
			{ width: 1000, height: 500 },
			{ width: 600, height: 400 },
			50,
		);

		expect(camera.scale).toBeCloseTo(0.5, 8);
		expect(camera.tx).toBeCloseTo(50, 8);
		expect(camera.ty).toBeCloseTo(75, 8);
	});

	it("does not force fit below the gesture zoom minimum unless limits are supplied", () => {
		const unconstrained = fit(
			{ width: 10000, height: 10000 },
			{ width: 100, height: 100 },
		);
		const constrained = fit(
			{ width: 10000, height: 10000 },
			{ width: 100, height: 100 },
			0,
			{ min: 0.05, max: 32 },
		);

		expect(unconstrained.scale).toBeCloseTo(0.01, 8);
		expect(constrained.scale).toBe(0.05);
	});

	it("fills width with padding and keeps the top edge visible for vertical pages", () => {
		const camera = fillWidth(
			{ width: 1000, height: 2200 },
			{ width: 600, height: 400 },
			50,
		);

		expect(camera.scale).toBeCloseTo(0.5, 8);
		expect(camera.tx).toBeCloseTo(50, 8);
		expect(camera.ty).toBeCloseTo(50, 8);
	});

	it("returns identity camera when fit inputs are not usable", () => {
		expect(fit({ width: 0, height: 400 }, { width: 800, height: 600 })).toEqual({
			scale: 1,
			tx: 0,
			ty: 0,
		});
		expect(fillWidth({ width: 400, height: 400 }, { width: Number.NaN, height: 600 })).toEqual({
			scale: 1,
			tx: 0,
			ty: 0,
		});
	});

	it("round-trips screen and image points", () => {
		const camera: Camera = { scale: 2.5, tx: -30, ty: 45 };
		const screenPoint = { x: 220, y: 170 };
		const imagePoint = screenToImage(camera, screenPoint);

		expectPointClose(imagePoint, { x: 100, y: 50 });
		expectPointClose(imageToScreen(camera, imagePoint), screenPoint);
	});

	it("round-trips rectangles and normalizes inverted dimensions", () => {
		const camera: Camera = { scale: 2, tx: 20, ty: -10 };
		const screenRect = { x: 220, y: 90, width: -80, height: 120 };

		const imageRect = screenRectToImage(camera, screenRect);
		const roundTrip = imageRectToScreen(camera, imageRect);

		expect(imageRect).toEqual({ x: 60, y: 50, width: 40, height: 60 });
		expect(roundTrip).toEqual({ x: 140, y: 90, width: 80, height: 120 });
	});

	it("allows rubber-band pan beyond a large image then settles back to strict bounds", () => {
		const camera: Camera = { scale: 1, tx: 0, ty: 0 };
		const options = {
			imageSize: { width: 1000, height: 800 },
			viewportSize: { width: 400, height: 300 },
			padding: 20,
			rubberBand: 48,
		};

		const dragged = pan(camera, { x: 160, y: 140 }, options);
		const settled = settlePan(dragged, options);

		expect(dragged).toEqual({ scale: 1, tx: 68, ty: 68 });
		expect(settled).toEqual({ scale: 1, tx: 20, ty: 20 });
	});

	it("centers content smaller than the viewport and rubber-bands around that center", () => {
		const camera: Camera = { scale: 1, tx: 150, ty: 110 };
		const options = {
			imageSize: { width: 100, height: 80 },
			viewportSize: { width: 400, height: 300 },
			rubberBand: 32,
		};

		const dragged = pan(camera, { x: 200, y: 200 }, options);
		const settled = settlePan(dragged, options);

		expect(dragged).toEqual({ scale: 1, tx: 182, ty: 142 });
		expect(settled).toEqual({ scale: 1, tx: 150, ty: 110 });
	});

	it("reports pan bounds with the default rubber-band allowance", () => {
		const bounds = getPanBounds(
			{ scale: 1, tx: 0, ty: 0 },
			{
				imageSize: { width: 1000, height: 800 },
				viewportSize: { width: 400, height: 300 },
				padding: 20,
			},
		);

		expect(bounds).toEqual({
			minTx: -620 - DEFAULT_RUBBER_BAND,
			maxTx: 20 + DEFAULT_RUBBER_BAND,
			minTy: -520 - DEFAULT_RUBBER_BAND,
			maxTy: 20 + DEFAULT_RUBBER_BAND,
		});
	});

	it("walks the smooth zoom preset ladder in both directions", () => {
		expect(nextZoomScale(0.5, "in")).toBeCloseTo(0.66, 8);
		expect(nextZoomScale(0.7, "out")).toBeCloseTo(0.66, 8);
		expect(nextZoomScale(1, "in")).toBe(2);
		expect(nextZoomScale(1, "out")).toBeCloseTo(0.66, 8);
		expect(nextZoomScale(5, "in")).toBe(10);
	});

	it("clamps smooth zoom steps to custom limits", () => {
		expect(nextZoomScale(3, "in", { limits: { min: 0.5, max: 4 } })).toBe(4);
		expect(nextZoomScale(0.5, "out", { limits: { min: 0.5, max: 4 } })).toBe(0.5);
	});

	it("zooms to the next preset while preserving the cursor anchor", () => {
		const camera: Camera = { scale: 1, tx: 10, ty: 20 };
		const cursor = { x: 180, y: 160 };
		const imagePoint = screenToImage(camera, cursor);

		const next = zoomToNextStep(camera, cursor, "in");

		expect(next.scale).toBe(2);
		expectPointClose(imageToScreen(next, imagePoint), cursor);
	});

	it("only enables pixel grid above 800 percent zoom", () => {
		expect(shouldShowPixelGrid(8)).toBe(false);
		expect(shouldShowPixelGrid({ scale: 8, tx: 0, ty: 0 })).toBe(false);
		expect(shouldShowPixelGrid(8.0001)).toBe(true);
		expect(shouldShowPixelGrid(Number.POSITIVE_INFINITY)).toBe(false);
	});
});
