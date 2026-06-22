import { describe, expect, it } from "vitest";
import {
	applyMatrixToPoint,
	applyTransformToImageData,
	composeMatrix,
	createTransformHandleModel,
	IDENTITY_MATRIX,
	invertMatrix,
	multiplyMatrices,
	rotateMatrix,
	scaleMatrix,
	skewMatrix,
	snapRotation,
	translateMatrix,
	type ImageDataLike,
	type Matrix2D,
	type Point,
} from "$lib/editor-tools/transform.ts";

const COLORS = {
	red: [255, 0, 0, 255],
	green: [0, 255, 0, 255],
	blue: [0, 0, 255, 255],
	white: [255, 255, 255, 255],
	transparent: [0, 0, 0, 0],
} as const;

function expectPointClose(actual: Point, expected: Point, precision = 6): void {
	expect(actual.x).toBeCloseTo(expected.x, precision);
	expect(actual.y).toBeCloseTo(expected.y, precision);
}

function expectMatrixClose(actual: Matrix2D, expected: Matrix2D, precision = 6): void {
	expect(actual.a).toBeCloseTo(expected.a, precision);
	expect(actual.b).toBeCloseTo(expected.b, precision);
	expect(actual.c).toBeCloseTo(expected.c, precision);
	expect(actual.d).toBeCloseTo(expected.d, precision);
	expect(actual.e).toBeCloseTo(expected.e, precision);
	expect(actual.f).toBeCloseTo(expected.f, precision);
}

function makeImage(width: number, height: number, pixels: readonly (readonly number[])[]): ImageDataLike {
	return {
		width,
		height,
		data: new Uint8ClampedArray(pixels.flat()),
	};
}

function pixel(image: ImageDataLike, x: number, y: number): number[] {
	const offset = (y * image.width + x) * 4;
	return Array.from(image.data).slice(offset, offset + 4);
}

describe("Matrix2D", () => {
	it("keeps points unchanged through the identity matrix", () => {
		expectPointClose(applyMatrixToPoint(IDENTITY_MATRIX, { x: 12, y: -4 }), { x: 12, y: -4 });
	});

	it("composes translate, scale, rotate, and skew matrices", () => {
		const matrix = composeMatrix(
			translateMatrix(10, -3),
			scaleMatrix(2, 3),
			rotateMatrix(90),
			skewMatrix(45, 0),
		);

		expectPointClose(applyMatrixToPoint(matrix, { x: 2, y: 1 }), { x: 8, y: 6 });
	});

	it("inverts composed matrices for point round trips", () => {
		const matrix = composeMatrix(
			translateMatrix(20, -8),
			rotateMatrix(30),
			scaleMatrix(2, 0.5),
			skewMatrix(8, -4),
		);
		const inverse = invertMatrix(matrix);
		const point = { x: 17, y: -11 };

		expectPointClose(applyMatrixToPoint(inverse, applyMatrixToPoint(matrix, point)), point);
		expectMatrixClose(multiplyMatrices(matrix, inverse), IDENTITY_MATRIX);
	});

	it("throws for singular matrices that cannot be inverted", () => {
		expect(() => invertMatrix(scaleMatrix(0, 1))).toThrow(RangeError);
	});
});

describe("transform handle model", () => {
	it("returns 8 resize handles and one rotation handle for identity bounds", () => {
		const model = createTransformHandleModel({ x: 10, y: 20, width: 100, height: 50 }, IDENTITY_MATRIX);

		expect(model.handles).toHaveLength(9);
		expect(model.handles).toContainEqual({ handle: "top-left", point: { x: 10, y: 20 } });
		expect(model.handles).toContainEqual({ handle: "right", point: { x: 110, y: 45 } });
		expect(model.handles).toContainEqual({ handle: "rotate", point: { x: 60, y: -12 } });
	});

	it("hit-tests the closest handle and ignores misses outside the radius", () => {
		const model = createTransformHandleModel(
			{ x: 0, y: 0, width: 100, height: 50 },
			translateMatrix(10, 5),
			{ hitRadius: 6 },
		);

		expect(model.hitTest({ x: 111, y: 56 })).toBe("bottom-right");
		expect(model.hitTest({ x: 50, y: 50 })).toBeNull();
	});

	it("keeps aspect ratio when dragging a corner handle", () => {
		const model = createTransformHandleModel({ x: 0, y: 0, width: 100, height: 50 }, IDENTITY_MATRIX);
		const matrix = model.dragHandle("bottom-right", { x: 50, y: 0 }, { keepAspect: true });

		expectPointClose(applyMatrixToPoint(matrix, { x: 0, y: 0 }), { x: 0, y: 0 });
		expectPointClose(applyMatrixToPoint(matrix, { x: 100, y: 50 }), { x: 150, y: 75 });
	});

	it("scales from the center when requested", () => {
		const model = createTransformHandleModel({ x: 0, y: 0, width: 100, height: 50 }, IDENTITY_MATRIX);
		const matrix = model.dragHandle("right", { x: 50, y: 0 }, { fromCenter: true });

		expectPointClose(applyMatrixToPoint(matrix, { x: 50, y: 25 }), { x: 50, y: 25 });
		expectPointClose(applyMatrixToPoint(matrix, { x: 0, y: 0 }), { x: -50, y: 0 });
		expectPointClose(applyMatrixToPoint(matrix, { x: 100, y: 50 }), { x: 150, y: 50 });
	});

	it("rotates around the transformed selection center from the rotation handle", () => {
		const model = createTransformHandleModel({ x: 0, y: 0, width: 100, height: 100 }, IDENTITY_MATRIX);
		const matrix = model.dragHandle("rotate", { x: 82, y: 82 });

		expectPointClose(applyMatrixToPoint(matrix, { x: 50, y: 50 }), { x: 50, y: 50 });
		expectPointClose(applyMatrixToPoint(matrix, { x: 50, y: 0 }), { x: 100, y: 50 }, 0);
	});
});

describe("snapRotation", () => {
	it("snaps to the nearest degree step", () => {
		expect(snapRotation(44)).toBe(45);
		expect(snapRotation(-8)).toBe(-15);
		expect(snapRotation(22, 10)).toBe(20);
	});

	it("leaves angles unchanged for non-positive steps", () => {
		expect(snapRotation(23, 0)).toBe(23);
		expect(snapRotation(23, -15)).toBe(23);
	});
});

describe("applyTransformToImageData", () => {
	const source2x2 = makeImage(2, 2, [
		COLORS.red,
		COLORS.green,
		COLORS.blue,
		COLORS.white,
	]);

	it("copies pixels through the identity matrix", () => {
		const result = applyTransformToImageData(source2x2, IDENTITY_MATRIX, { x: 0, y: 0, width: 2, height: 2 });

		expect(result.width).toBe(2);
		expect(result.height).toBe(2);
		expect(Array.from(result.data)).toEqual(Array.from(source2x2.data));
	});

	it("scales 2x with bilinear sampling", () => {
		const result = applyTransformToImageData(source2x2, scaleMatrix(2), { x: 0, y: 0, width: 4, height: 4 });

		expect(pixel(result, 0, 0)).toEqual(COLORS.red);
		expect(pixel(result, 2, 0)).toEqual(COLORS.green);
		expect(pixel(result, 1, 1)).toEqual([128, 128, 128, 255]);
		expect(pixel(result, 3, 3)).toEqual(COLORS.white);
	});

	it("rotates 90 degrees counter-clockwise into the requested output bounds", () => {
		const result = applyTransformToImageData(source2x2, rotateMatrix(90), { x: -1, y: 0, width: 2, height: 2 });

		expect(pixel(result, 0, 0)).toEqual(COLORS.blue);
		expect(pixel(result, 1, 0)).toEqual(COLORS.red);
		expect(pixel(result, 0, 1)).toEqual(COLORS.white);
		expect(pixel(result, 1, 1)).toEqual(COLORS.green);
	});

	it("returns transparent pixels outside the source image", () => {
		const result = applyTransformToImageData(source2x2, IDENTITY_MATRIX, { x: 2, y: 2, width: 1, height: 1 });

		expect(pixel(result, 0, 0)).toEqual(COLORS.transparent);
	});

	it("validates RGBA data length", () => {
		expect(() =>
			applyTransformToImageData(
				{ width: 2, height: 2, data: new Uint8ClampedArray(15) },
				IDENTITY_MATRIX,
				{ x: 0, y: 0, width: 2, height: 2 },
			),
		).toThrow(RangeError);
	});
});
