import { describe, expect, it } from "vitest";
import {
	applyTransformToImageData,
	composeMatrix,
	IDENTITY_MATRIX,
	invertMatrix,
	multiplyMatrices,
	rotateMatrix,
	scaleMatrix,
	translateMatrix,
	type ImageDataLike,
	type Matrix2D,
	type TransformBounds,
} from "$lib/editor-tools/transform.ts";

type Rgba = readonly [number, number, number, number];

const TRANSPARENT: Rgba = [0, 0, 0, 0];
const A: Rgba = [10, 0, 0, 255];
const B: Rgba = [20, 0, 0, 255];
const C: Rgba = [30, 0, 0, 255];
const D: Rgba = [40, 0, 0, 255];
const E: Rgba = [50, 0, 0, 255];
const F: Rgba = [60, 0, 0, 255];

function makeImage(width: number, height: number, pixels: readonly Rgba[]): ImageDataLike {
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

function expectPixel(image: ImageDataLike, x: number, y: number, expected: Rgba): void {
	expect(pixel(image, x, y)).toEqual([...expected]);
}

function expectPixelClose(image: ImageDataLike, x: number, y: number, expected: Rgba, tolerance = 1): void {
	const actual = pixel(image, x, y);
	for (let channel = 0; channel < 4; channel += 1) {
		expect(actual[channel]).toBeGreaterThanOrEqual(expected[channel] - tolerance);
		expect(actual[channel]).toBeLessThanOrEqual(expected[channel] + tolerance);
	}
}

function expectRows(image: ImageDataLike, rows: readonly (readonly Rgba[])[]): void {
	expect(image.height).toBe(rows.length);
	expect(image.width).toBe(rows[0]?.length ?? 0);

	for (let y = 0; y < rows.length; y += 1) {
		for (let x = 0; x < rows[y].length; x += 1) {
			expectPixel(image, x, y, rows[y][x]);
		}
	}
}

describe("applyTransformToImageData rotation and flip coverage", () => {
	const source3x2 = makeImage(3, 2, [A, B, C, D, E, F]);

	it.each([
		{
			angle: 90,
			bounds: { x: -1, y: 0, width: 2, height: 3 },
			expected: [
				[D, A],
				[E, B],
				[F, C],
			],
		},
		{
			angle: 180,
			bounds: { x: -2, y: -1, width: 3, height: 2 },
			expected: [
				[F, E, D],
				[C, B, A],
			],
		},
		{
			angle: 270,
			bounds: { x: 0, y: -2, width: 2, height: 3 },
			expected: [
				[C, F],
				[B, E],
				[A, D],
			],
		},
	] satisfies readonly {
		angle: number;
		bounds: TransformBounds;
		expected: readonly (readonly Rgba[])[];
	}[])("rotates $angle degrees into the requested output bounds", ({ angle, bounds, expected }) => {
		const result = applyTransformToImageData(source3x2, rotateMatrix(angle), bounds);

		expectRows(result, expected);
	});

	it.each([
		{
			name: "horizontally",
			matrix: scaleMatrix(-1, 1),
			bounds: { x: -2, y: 0, width: 3, height: 2 },
			expected: [
				[C, B, A],
				[F, E, D],
			],
		},
		{
			name: "vertically",
			matrix: scaleMatrix(1, -1),
			bounds: { x: 0, y: -1, width: 3, height: 2 },
			expected: [
				[D, E, F],
				[A, B, C],
			],
		},
	] satisfies readonly {
		name: string;
		matrix: Matrix2D;
		bounds: TransformBounds;
		expected: readonly (readonly Rgba[])[];
	}[])("flips $name with negative scale matrices", ({ matrix, bounds, expected }) => {
		const result = applyTransformToImageData(source3x2, matrix, bounds);

		expectRows(result, expected);
	});
});

describe("applyTransformToImageData scale sampling coverage", () => {
	it("keeps nearest exact samples when scaled output lands on source pixel coordinates", () => {
		const source = makeImage(2, 2, [A, B, D, E]);
		const result = applyTransformToImageData(source, scaleMatrix(2), { x: 0, y: 0, width: 4, height: 4 });

		expectPixel(result, 0, 0, A);
		expectPixel(result, 2, 0, B);
		expectPixel(result, 0, 2, D);
		expectPixel(result, 2, 2, E);
	});

	it("bilinearly blends RGBA channels for fractional scaled samples", () => {
		const source = makeImage(2, 2, [
			[0, 0, 0, 200],
			[200, 0, 0, 100],
			[0, 200, 0, 100],
			[200, 200, 200, 0],
		]);
		const result = applyTransformToImageData(source, scaleMatrix(2), { x: 0, y: 0, width: 3, height: 3 });

		expectPixel(result, 1, 1, [100, 100, 50, 100]);
	});
});

describe("applyTransformToImageData edge cases", () => {
	it("samples a free-rotate angle without snapping to right angles", () => {
		const source = makeImage(3, 3, [
			[0, 0, 10, 255],
			[100, 0, 10, 255],
			[200, 0, 10, 255],
			[0, 100, 10, 255],
			[100, 100, 10, 255],
			[200, 100, 10, 255],
			[0, 200, 10, 255],
			[100, 200, 10, 255],
			[200, 200, 10, 255],
		]);
		const result = applyTransformToImageData(source, rotateMatrix(45, { x: 1, y: 1 }), {
			x: -1,
			y: -1,
			width: 5,
			height: 5,
		});

		expectPixel(result, 2, 2, [100, 100, 10, 255]);
		expectPixelClose(result, 2, 1, [29, 29, 10, 255]);
		expectPixel(result, 0, 0, TRANSPARENT);
		expectPixel(result, 4, 4, TRANSPARENT);
	});

	it("preserves pixels through a composed transform and inverse identity roundtrip", () => {
		const source = makeImage(3, 2, [A, B, C, D, E, F]);
		const transform = composeMatrix(translateMatrix(12, -7), rotateMatrix(37), scaleMatrix(1.25, 0.8), translateMatrix(-3, 5));
		const roundtrip = multiplyMatrices(transform, invertMatrix(transform));
		const result = applyTransformToImageData(source, roundtrip, { x: 0, y: 0, width: 3, height: 2 });

		expect(Array.from(result.data)).toEqual(Array.from(source.data));
	});

	it("zeros alpha at output edges that sample outside the source image", () => {
		const source = makeImage(2, 2, [A, B, D, E]);
		const result = applyTransformToImageData(source, IDENTITY_MATRIX, { x: -1, y: -1, width: 4, height: 4 });

		expectPixel(result, 0, 0, TRANSPARENT);
		expectPixel(result, 0, 2, TRANSPARENT);
		expectPixel(result, 1, 1, A);
		expectPixel(result, 2, 2, E);
		expectPixel(result, 3, 3, TRANSPARENT);
	});
});
