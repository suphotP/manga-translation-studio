import { describe, expect, it } from "vitest";
import {
	magicWandMask,
	type MagicWandImageData,
	type MagicWandMaskResult,
} from "$lib/editor-tools/magic-wand.ts";

type Rgba = readonly [number, number, number, number?];

function makeImage(width: number, height: number, color: Rgba): MagicWandImageData {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			paintPixel(data, width, x, y, color);
		}
	}
	return { data, width, height };
}

function paintPixel(data: Uint8ClampedArray, width: number, x: number, y: number, color: Rgba): void {
	const offset = (y * width + x) * 4;
	data[offset] = color[0];
	data[offset + 1] = color[1];
	data[offset + 2] = color[2];
	data[offset + 3] = color[3] ?? 255;
}

function drawCircle(image: MagicWandImageData, cx: number, cy: number, radius: number, color: Rgba): number {
	let painted = 0;
	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < image.width; x++) {
			const dx = x - cx;
			const dy = y - cy;
			if (dx * dx + dy * dy > radius * radius) continue;
			paintPixel(image.data, image.width, x, y, color);
			painted++;
		}
	}
	return painted;
}

function drawRect(image: MagicWandImageData, x0: number, y0: number, x1: number, y1: number, color: Rgba): void {
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			paintPixel(image.data, image.width, x, y, color);
		}
	}
}

function countSelected(result: MagicWandMaskResult): number {
	let count = 0;
	for (const value of result.mask) if (value !== 0) count++;
	return count;
}

function selectedAt(result: MagicWandMaskResult, x: number, y: number, width: number): number {
	return result.mask[y * width + x] ?? 0;
}

describe("magicWandMask", () => {
	it("wraps magic-wand-tool for contiguous flood selection", () => {
		const image = makeImage(34, 24, [0, 0, 0]);
		const firstCircle = drawCircle(image, 8, 12, 5, [255, 255, 255]);
		drawCircle(image, 25, 12, 4, [255, 255, 255]);

		const result = magicWandMask(image, 8, 12, 0, true);

		expect(countSelected(result)).toBe(firstCircle);
		expect(result.bounds).toEqual({ minX: 3, minY: 7, maxX: 13, maxY: 17 });
		expect(selectedAt(result, 8, 12, image.width)).toBe(255);
		expect(selectedAt(result, 25, 12, image.width)).toBe(0);
		expect(selectedAt(result, 0, 0, image.width)).toBe(0);
	});

	it("supports non-contiguous color selection across the whole image", () => {
		const image = makeImage(34, 24, [0, 0, 0]);
		const firstCircle = drawCircle(image, 8, 12, 5, [255, 255, 255]);
		const secondCircle = drawCircle(image, 25, 12, 4, [255, 255, 255]);

		const result = magicWandMask(image, 8, 12, 0, false);

		expect(countSelected(result)).toBe(firstCircle + secondCircle);
		expect(result.bounds).toEqual({ minX: 3, minY: 7, maxX: 29, maxY: 17 });
		expect(selectedAt(result, 8, 12, image.width)).toBe(255);
		expect(selectedAt(result, 25, 12, image.width)).toBe(255);
		expect(selectedAt(result, 0, 0, image.width)).toBe(0);
	});

	it("uses the same per-channel RGB tolerance for non-contiguous scans", () => {
		const image = makeImage(5, 1, [0, 0, 0]);
		paintPixel(image.data, image.width, 0, 0, [250, 250, 250, 255]);
		paintPixel(image.data, image.width, 1, 0, [244, 251, 246, 255]);
		paintPixel(image.data, image.width, 2, 0, [240, 250, 250, 255]);
		paintPixel(image.data, image.width, 3, 0, [250, 250, 250, 0]);

		const result = magicWandMask(image, 0, 0, 6, false);

		expect([...result.mask]).toEqual([255, 255, 0, 255, 0]);
		expect(result.bounds).toEqual({ minX: 0, minY: 0, maxX: 3, maxY: 0 });
	});

	it("fills enclosed black lettering holes inside a selected manga bubble", () => {
		const image = makeImage(31, 31, [0, 0, 0]);
		drawCircle(image, 15, 15, 10, [255, 255, 255]);
		// The strokes are isolated inside the bubble so fillHoles should recover them as editable selection.
		drawRect(image, 13, 10, 16, 21, [0, 0, 0]);
		drawRect(image, 10, 14, 20, 17, [0, 0, 0]);

		const openMask = magicWandMask(image, 15, 6, 0, true);
		const filledMask = magicWandMask(image, 15, 6, 0, true, { fillHoles: true });

		expect(selectedAt(openMask, 14, 12, image.width)).toBe(0);
		expect(selectedAt(filledMask, 14, 12, image.width)).toBe(255);
		expect(selectedAt(filledMask, 15, 15, image.width)).toBe(255);
		expect(selectedAt(filledMask, 5, 5, image.width)).toBe(0);
		expect(selectedAt(filledMask, 0, 0, image.width)).toBe(0);
		expect(countSelected(filledMask)).toBeGreaterThan(countSelected(openMask));
		expect(filledMask.bounds).toEqual(openMask.bounds);
	});

	it("fills nested donut holes inside the selected outer shape", () => {
		const image = makeImage(19, 19, [0, 0, 0]);
		drawRect(image, 2, 2, 17, 17, [255, 255, 255]);
		drawRect(image, 5, 5, 14, 14, [0, 0, 0]);
		drawRect(image, 7, 7, 12, 12, [255, 255, 255]);
		drawRect(image, 9, 9, 10, 10, [0, 0, 0]);

		const openMask = magicWandMask(image, 3, 3, 0, true);
		const filledMask = magicWandMask(image, 3, 3, 0, true, { fillHoles: true });

		expect(selectedAt(openMask, 6, 6, image.width)).toBe(0);
		expect(selectedAt(openMask, 8, 8, image.width)).toBe(0);
		expect(selectedAt(openMask, 9, 9, image.width)).toBe(0);
		expect(selectedAt(filledMask, 6, 6, image.width)).toBe(255);
		expect(selectedAt(filledMask, 8, 8, image.width)).toBe(255);
		expect(selectedAt(filledMask, 9, 9, image.width)).toBe(255);
		expect(selectedAt(filledMask, 1, 1, image.width)).toBe(0);
		expect(countSelected(filledMask)).toBe(15 * 15);
		expect(filledMask.bounds).toEqual(openMask.bounds);
	});

	it("fills holes after non-contiguous selection without bridging the page background", () => {
		const image = makeImage(18, 10, [0, 0, 0]);
		drawRect(image, 2, 2, 7, 8, [255, 255, 255]);
		drawRect(image, 11, 2, 16, 8, [255, 255, 255]);
		drawRect(image, 4, 4, 5, 6, [0, 0, 0]);
		drawRect(image, 13, 4, 14, 6, [0, 0, 0]);

		const result = magicWandMask(image, 2, 2, 0, false, { fillHoles: true });

		expect(selectedAt(result, 4, 4, image.width)).toBe(255);
		expect(selectedAt(result, 13, 4, image.width)).toBe(255);
		expect(selectedAt(result, 9, 5, image.width)).toBe(0);
		expect(result.bounds).toEqual({ minX: 2, minY: 2, maxX: 15, maxY: 7 });
	});

	it("keeps tolerance zero exact on anti-aliased edges", () => {
		const image = makeImage(9, 9, [0, 0, 0]);
		drawRect(image, 1, 1, 8, 8, [252, 252, 252]);
		drawRect(image, 3, 3, 6, 6, [255, 255, 255]);

		const exactMask = magicWandMask(image, 4, 3, 0, true);

		expect(countSelected(exactMask)).toBe(9);
		expect(exactMask.bounds).toEqual({ minX: 3, minY: 3, maxX: 5, maxY: 5 });
		expect(selectedAt(exactMask, 4, 4, image.width)).toBe(255);
		expect(selectedAt(exactMask, 2, 4, image.width)).toBe(0);
		expect(selectedAt(exactMask, 1, 1, image.width)).toBe(0);
	});

	it("handles alpha-zero seeds and preserves contiguous versus global RGB scan semantics", () => {
		const image = makeImage(6, 1, [255, 255, 255]);
		paintPixel(image.data, image.width, 0, 0, [40, 40, 40, 0]);
		paintPixel(image.data, image.width, 1, 0, [40, 40, 40, 0]);
		paintPixel(image.data, image.width, 2, 0, [40, 40, 40, 255]);
		paintPixel(image.data, image.width, 4, 0, [40, 40, 40, 0]);

		const contiguousMask = magicWandMask(image, 0, 0, 0, true);
		const globalMask = magicWandMask(image, 0, 0, 0, false);

		expect([...contiguousMask.mask]).toEqual([255, 255, 255, 0, 0, 0]);
		expect(contiguousMask.bounds).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 0 });
		expect([...globalMask.mask]).toEqual([255, 255, 255, 0, 255, 0]);
		expect(globalMask.bounds).toEqual({ minX: 0, minY: 0, maxX: 4, maxY: 0 });
	});

	it("keeps large fillHoles scans iterative for open selections", () => {
		const image = makeImage(360, 260, [0, 0, 0]);
		drawRect(image, 20, 20, 340, 24, [255, 255, 255]);
		drawRect(image, 20, 236, 340, 240, [255, 255, 255]);
		drawRect(image, 336, 20, 340, 240, [255, 255, 255]);

		const openMask = magicWandMask(image, 25, 22, 0, true);
		const filledMask = magicWandMask(image, 25, 22, 0, true, { fillHoles: true });

		expect(selectedAt(filledMask, 180, 130, image.width)).toBe(0);
		expect(selectedAt(filledMask, 20, 22, image.width)).toBe(255);
		expect(selectedAt(filledMask, 338, 130, image.width)).toBe(255);
		expect(countSelected(filledMask)).toBe(countSelected(openMask));
		expect(filledMask.bounds).toEqual({ minX: 20, minY: 20, maxX: 339, maxY: 239 });
	});

	it("returns an empty full-size mask for invalid clicks", () => {
		const image = makeImage(4, 3, [255, 255, 255]);

		const result = magicWandMask(image, -1, 99, 10, true, { fillHoles: true });

		expect(result.mask).toHaveLength(12);
		expect(countSelected(result)).toBe(0);
		expect(result.bounds).toEqual({ minX: 0, minY: 0, maxX: -1, maxY: -1 });
	});

	it("fails closed for malformed image buffers", () => {
		const result = magicWandMask({ data: new Uint8ClampedArray(3), width: 2, height: 2 }, 0, 0, 0, false);

		expect(result.mask).toHaveLength(4);
		expect(countSelected(result)).toBe(0);
		expect(result.bounds).toEqual({ minX: 0, minY: 0, maxX: -1, maxY: -1 });
	});
});
