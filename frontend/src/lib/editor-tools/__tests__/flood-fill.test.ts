import { describe, expect, it } from "vitest";
import { fillMask, floodFill, type ImageDataLike } from "$lib/editor-tools/flood-fill.ts";

type Rgb = readonly [number, number, number];
type Rgba = readonly [number, number, number, number];

function makeImage(width: number, height: number, pixel: (x: number, y: number) => Rgba): ImageDataLike {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			writePixel(data, width, x, y, pixel(x, y));
		}
	}
	return { data, width, height };
}

function solidImage(width: number, height: number, color: Rgba): ImageDataLike {
	return makeImage(width, height, () => color);
}

function rgbStrip(values: readonly number[]): ImageDataLike {
	return makeImage(values.length, 1, (x) => [values[x], values[x], values[x], 255]);
}

function writePixel(data: Uint8ClampedArray, width: number, x: number, y: number, color: Rgba): void {
	const offset = (y * width + x) * 4;
	data[offset] = color[0];
	data[offset + 1] = color[1];
	data[offset + 2] = color[2];
	data[offset + 3] = color[3];
}

function pixel(image: ImageDataLike, x: number, y: number): Rgba {
	const offset = (y * image.width + x) * 4;
	return [
		image.data[offset],
		image.data[offset + 1],
		image.data[offset + 2],
		image.data[offset + 3],
	];
}

function rgb(image: ImageDataLike, x: number, y: number): Rgb {
	const [r, g, b] = pixel(image, x, y);
	return [r, g, b];
}

describe("floodFill", () => {
	it("fills only an exact contiguous region when tolerance is zero", () => {
		const image = makeImage(5, 3, (x, y) => {
			if (x >= 1 && x <= 3 && y >= 0 && y <= 2) return [10, 10, 10, 255];
			return [11, 11, 11, 255];
		});

		const result = floodFill(image, 2, 1, [200, 20, 30, 255], { tolerance: 0 });

		expect(result).toEqual({ changed: true, boundsRect: { x: 1, y: 0, width: 3, height: 3 } });
		expect(rgb(image, 2, 1)).toEqual([200, 20, 30]);
		expect(rgb(image, 0, 1)).toEqual([11, 11, 11]);
		expect(rgb(image, 4, 1)).toEqual([11, 11, 11]);
	});

	it("uses high tolerance to include near colors in the same connected span", () => {
		const image = rgbStrip([10, 12, 40, 250]);

		const result = floodFill(image, 0, 0, [1, 2, 3, 255], { tolerance: 30 });

		expect(result.boundsRect).toEqual({ x: 0, y: 0, width: 3, height: 1 });
		expect(rgb(image, 0, 0)).toEqual([1, 2, 3]);
		expect(rgb(image, 1, 0)).toEqual([1, 2, 3]);
		expect(rgb(image, 2, 0)).toEqual([1, 2, 3]);
		expect(rgb(image, 3, 0)).toEqual([250, 250, 250]);
	});

	it("softens anti-aliased edge pixels near the tolerance threshold", () => {
		const image = rgbStrip([255, 248, 241, 236, 200]);

		const result = floodFill(image, 0, 0, [20, 40, 60, 255], { tolerance: 20, antiAlias: true });

		expect(result.boundsRect).toEqual({ x: 0, y: 0, width: 4, height: 1 });
		expect(pixel(image, 0, 0)).toEqual([20, 40, 60, 255]);
		expect(pixel(image, 2, 0)).toEqual([20, 40, 60, 255]);
		expect(rgb(image, 3, 0)).toEqual([20, 40, 60]);
		expect(pixel(image, 3, 0)[3]).toBeGreaterThan(0);
		expect(pixel(image, 3, 0)[3]).toBeLessThan(255);
		expect(pixel(image, 4, 0)).toEqual([200, 200, 200, 255]);
	});

	it("keeps threshold-matched pixels fully opaque when antiAlias is off", () => {
		const image = rgbStrip([255, 248, 241, 236]);

		floodFill(image, 0, 0, [20, 40, 60, 255], { tolerance: 20, antiAlias: false });

		expect(pixel(image, 3, 0)).toEqual([20, 40, 60, 255]);
	});

	it("can fill every matching color when contiguous is false", () => {
		const contiguous = makeImage(5, 3, (x, y) => {
			if (y === 1 && (x === 0 || x === 4)) return [0, 0, 0, 255];
			return [255, 255, 255, 255];
		});
		const allMatches = makeImage(5, 3, (x, y) => {
			if (y === 1 && (x === 0 || x === 4)) return [0, 0, 0, 255];
			return [255, 255, 255, 255];
		});

		const contiguousResult = floodFill(contiguous, 0, 1, [255, 0, 0, 255], { tolerance: 0 });
		const allResult = floodFill(allMatches, 0, 1, [255, 0, 0, 255], { tolerance: 0, contiguous: false });

		expect(contiguousResult.boundsRect).toEqual({ x: 0, y: 1, width: 1, height: 1 });
		expect(rgb(contiguous, 4, 1)).toEqual([0, 0, 0]);
		expect(allResult.boundsRect).toEqual({ x: 0, y: 1, width: 5, height: 1 });
		expect(rgb(allMatches, 0, 1)).toEqual([255, 0, 0]);
		expect(rgb(allMatches, 4, 1)).toEqual([255, 0, 0]);
	});

	it("fills the full image in non-contiguous mode when every pixel matches", () => {
		const image = solidImage(3, 2, [24, 25, 26, 255]);

		const result = floodFill(image, 1, 1, [200, 100, 50, 255], { contiguous: false });

		expect(result).toEqual({ changed: true, boundsRect: { x: 0, y: 0, width: 3, height: 2 } });
		for (let y = 0; y < image.height; y++) {
			for (let x = 0; x < image.width; x++) {
				expect(pixel(image, x, y)).toEqual([200, 100, 50, 255]);
			}
		}
	});

	it("applies antiAlias only across the outer tolerance band", () => {
		const image = rgbStrip([100, 94, 93, 92, 91]);

		const result = floodFill(image, 0, 0, [10, 20, 30, 240], { tolerance: 8, antiAlias: true });

		expect(result).toEqual({ changed: true, boundsRect: { x: 0, y: 0, width: 4, height: 1 } });
		expect(pixel(image, 0, 0)).toEqual([10, 20, 30, 240]);
		expect(pixel(image, 1, 0)).toEqual([10, 20, 30, 240]);
		expect(pixel(image, 2, 0)).toEqual([10, 20, 30, 160]);
		expect(pixel(image, 3, 0)).toEqual([10, 20, 30, 80]);
		expect(pixel(image, 4, 0)).toEqual([91, 91, 91, 255]);
	});

	it("treats tolerance 255 as the full per-channel range", () => {
		const image = makeImage(2, 2, (x, y) => {
			if (x === 0 && y === 0) return [0, 0, 0, 0];
			if (x === 1 && y === 0) return [255, 255, 255, 255];
			if (x === 0 && y === 1) return [200, 0, 255, 128];
			return [42, 150, 7, 1];
		});

		const result = floodFill(image, 0, 0, [1, 2, 3, 255], { tolerance: 255 });

		expect(result).toEqual({ changed: true, boundsRect: { x: 0, y: 0, width: 2, height: 2 } });
		expect(pixel(image, 0, 0)).toEqual([1, 2, 3, 255]);
		expect(pixel(image, 1, 0)).toEqual([1, 2, 3, 255]);
		expect(pixel(image, 0, 1)).toEqual([1, 2, 3, 255]);
		expect(pixel(image, 1, 1)).toEqual([1, 2, 3, 255]);
	});

	it("leaves the image unchanged when the seed already has the fill color", () => {
		const image = makeImage(3, 1, (x) => {
			if (x === 1) return [0, 0, 0, 255];
			return [7, 8, 9, 255];
		});
		const before = [...image.data];

		const result = floodFill(image, 0, 0, [7, 8, 9, 255], { contiguous: false });

		expect(result).toEqual({ changed: false, boundsRect: null });
		expect([...image.data]).toEqual(before);
	});

	it("fills a one-pixel image and reports a one-pixel boundsRect", () => {
		const image = solidImage(1, 1, [4, 5, 6, 255]);

		const result = floodFill(image, 0, 0, [9, 10, 11, 255]);

		expect(result).toEqual({ changed: true, boundsRect: { x: 0, y: 0, width: 1, height: 1 } });
		expect(pixel(image, 0, 0)).toEqual([9, 10, 11, 255]);
	});

	it("reports boundsRect from the exact changed pixel extents", () => {
		const image = makeImage(5, 4, (x, y) => {
			if (x === 0 && y === 0) return [12, 12, 12, 255];
			if (x >= 2 && x <= 3 && y >= 1 && y <= 2) return [12, 12, 12, 255];
			return [99, 99, 99, 255];
		});

		const result = floodFill(image, 2, 1, [80, 90, 100, 255]);

		expect(result).toEqual({ changed: true, boundsRect: { x: 2, y: 1, width: 2, height: 2 } });
		expect(pixel(image, 0, 0)).toEqual([12, 12, 12, 255]);
		expect(pixel(image, 2, 1)).toEqual([80, 90, 100, 255]);
		expect(pixel(image, 3, 2)).toEqual([80, 90, 100, 255]);
		expect(pixel(image, 4, 3)).toEqual([99, 99, 99, 255]);
	});

	it("reports no change for out-of-bounds starts or identical fill colors", () => {
		const image = solidImage(2, 2, [8, 9, 10, 255]);
		const before = [...image.data];

		expect(floodFill(image, -1, 0, [1, 2, 3, 255])).toEqual({ changed: false, boundsRect: null });
		expect([...image.data]).toEqual(before);
		expect(floodFill(image, 0, 0, [8, 9, 10, 255])).toEqual({ changed: false, boundsRect: null });
	});

	it("validates image dimensions and RGBA buffer length", () => {
		expect(() => floodFill({ data: new Uint8ClampedArray(3), width: 1, height: 1 }, 0, 0, [0, 0, 0, 255])).toThrow(
			/image data length/,
		);
		expect(() => floodFill({ data: new Uint8ClampedArray(0), width: 1.5, height: 1 }, 0, 0, [0, 0, 0, 255])).toThrow(
			/width/,
		);
	});
});

describe("fillMask", () => {
	it("fills selected mask pixels and scales alpha by mask coverage", () => {
		const image = solidImage(4, 1, [0, 0, 0, 255]);
		const mask = new Uint8Array([0, 255, 128, 0]);

		const result = fillMask(image, mask, [10, 20, 30, 200]);

		expect(result).toEqual({ changed: true, boundsRect: { x: 1, y: 0, width: 2, height: 1 } });
		expect(pixel(image, 0, 0)).toEqual([0, 0, 0, 255]);
		expect(pixel(image, 1, 0)).toEqual([10, 20, 30, 200]);
		expect(pixel(image, 2, 0)).toEqual([10, 20, 30, 100]);
		expect(pixel(image, 3, 0)).toEqual([0, 0, 0, 255]);
	});

	it("returns unchanged for an empty mask", () => {
		const image = solidImage(2, 2, [0, 0, 0, 255]);

		expect(fillMask(image, new Uint8Array(4), [255, 255, 255, 255])).toEqual({ changed: false, boundsRect: null });
	});

	it("rejects masks that do not match the image pixel count", () => {
		const image = solidImage(2, 2, [0, 0, 0, 255]);

		expect(() => fillMask(image, new Uint8Array(3), [255, 255, 255, 255])).toThrow(/mask length/);
	});
});
