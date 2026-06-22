import { describe, expect, it } from "vitest";
import { detectBubbles, suggestCleanMask, type ImageDataLike } from "../bubble-detect.ts";

function countMask(mask: Uint8Array): number {
	let count = 0;
	for (const value of mask) if (value > 0) count++;
	return count;
}

function pixelIndex(width: number, x: number, y: number): number {
	return y * width + x;
}

function paintPixel(image: Uint8Array, width: number, x: number, y: number, rgb: readonly [number, number, number]): void {
	const offset = pixelIndex(width, x, y) * 4;
	image[offset] = rgb[0];
	image[offset + 1] = rgb[1];
	image[offset + 2] = rgb[2];
	image[offset + 3] = 255;
}

function fillRect(
	image: Uint8Array,
	width: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	rgb: readonly [number, number, number],
): void {
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) paintPixel(image, width, x, y, rgb);
	}
}

function makePatternedPage(width = 128, height = 96): ImageDataLike {
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const shade = 88 + ((x * 7 + y * 11) % 36);
			paintPixel(data, width, x, y, [shade, shade + 3, shade + 6]);
		}
	}
	return { data, width, height };
}

function addBubble(
	image: ImageDataLike,
	centerX = 62,
	centerY = 45,
	radiusX = 34,
	radiusY = 22,
	options: { text?: boolean; tail?: boolean } = { text: true },
): void {
	const data = image.data as Uint8Array;
	for (let y = Math.max(0, centerY - radiusY - 3); y < Math.min(image.height, centerY + radiusY + 4); y++) {
		for (let x = Math.max(0, centerX - radiusX - 3); x < Math.min(image.width, centerX + radiusX + 4); x++) {
			const ellipse = ((x - centerX) * (x - centerX)) / (radiusX * radiusX) + ((y - centerY) * (y - centerY)) / (radiusY * radiusY);
			if (ellipse <= 1) {
				paintPixel(data, image.width, x, y, ellipse > 0.84 ? [18, 18, 18] : [250, 250, 247]);
			}
		}
	}
	if (options.tail) {
		for (let y = centerY + 10; y < centerY + 24; y++) {
			const halfWidth = Math.max(1, Math.floor((centerY + 24 - y) / 2));
			for (let x = centerX + 18 - halfWidth; x <= centerX + 18 + halfWidth; x++) {
				paintPixel(data, image.width, x, y, [250, 250, 247]);
			}
		}
	}
	if (options.text !== false) {
		fillRect(data, image.width, centerX - 17, centerY - 8, centerX + 18, centerY - 4, [20, 20, 20]);
		fillRect(data, image.width, centerX - 14, centerY + 3, centerX + 12, centerY + 7, [20, 20, 20]);
		fillRect(data, image.width, centerX + 19, centerY - 4, centerX + 23, centerY + 10, [20, 20, 20]);
	}
}

function makeSyntheticBubblePage(): ImageDataLike {
	const image = makePatternedPage();
	addBubble(image);
	const data = image.data as Uint8Array;
	fillRect(data, image.width, 4, 4, 7, 7, [252, 252, 252]);
	fillRect(data, image.width, 0, 78, image.width, image.height, [251, 251, 251]);
	return image;
}

describe("detectBubbles", () => {
	it("finds a white text bubble on a patterned manga page and fills text holes in its mask", () => {
		const image = makeSyntheticBubblePage();
		const bubbles = detectBubbles(image);

		expect(bubbles).toHaveLength(1);
		const bubble = bubbles[0];
		expect(bubble.mask).toBeInstanceOf(Uint8Array);
		expect(bubble.score).toBeGreaterThan(0.65);
		expect(bubble.bounds.x).toBeGreaterThanOrEqual(28);
		expect(bubble.bounds.x).toBeLessThanOrEqual(35);
		expect(bubble.bounds.y).toBeGreaterThanOrEqual(22);
		expect(bubble.bounds.y).toBeLessThanOrEqual(30);
		expect(bubble.bounds.width).toBeGreaterThan(45);
		expect(bubble.bounds.height).toBeGreaterThan(28);

		expect(bubble.mask[pixelIndex(image.width, 62, 45)]).toBe(255);
		expect(bubble.mask[pixelIndex(image.width, 52, 38)]).toBe(255);
		expect(bubble.mask[pixelIndex(image.width, 5, 5)]).toBe(0);
		expect(bubble.mask[pixelIndex(image.width, 10, 90)]).toBe(0);
	});

	it("rejects bright shapes without interior ink because they are poor clean targets", () => {
		const image = makePatternedPage();
		addBubble(image, 62, 45, 34, 22, { text: false });

		expect(detectBubbles(image)).toEqual([]);
	});

	it("returns no candidates for invalid or empty image buffers", () => {
		expect(detectBubbles({ width: 0, height: 20, data: new Uint8Array(0) })).toEqual([]);
		expect(detectBubbles({ width: 10, height: 10, data: new Uint8Array(12) })).toEqual([]);
	});
});

describe("suggestCleanMask", () => {
	it("floods the clicked bright bubble, fills dark glyph holes, and expands by two pixels", () => {
		const image = makePatternedPage();
		addBubble(image);

		const brightOnly = detectBubbles(image)[0];
		const cleanMask = suggestCleanMask(image, { x: 62, y: 45 });

		expect(cleanMask).toBeInstanceOf(Uint8Array);
		expect(cleanMask).toHaveLength(image.width * image.height);
		expect(cleanMask[pixelIndex(image.width, 62, 45)]).toBe(255);
		expect(cleanMask[pixelIndex(image.width, 52, 38)]).toBe(255);
		expect(cleanMask[pixelIndex(image.width, 29, 45)]).toBe(255);
		expect(cleanMask[pixelIndex(image.width, 2, 2)]).toBe(0);
		expect(countMask(cleanMask)).toBeGreaterThan(countMask(brightOnly.mask));
	});

	it("fails closed for dark/outside clicks and for huge white regions", () => {
		const image = makePatternedPage();
		addBubble(image);
		expect(countMask(suggestCleanMask(image, { x: 52, y: 38 }))).toBe(0);
		expect(countMask(suggestCleanMask(image, { x: -1, y: 45 }))).toBe(0);

		const allWhite = new Uint8Array(40 * 30 * 4);
		for (let i = 0; i < 40 * 30; i++) {
			const offset = i * 4;
			allWhite[offset] = 255;
			allWhite[offset + 1] = 255;
			allWhite[offset + 2] = 255;
			allWhite[offset + 3] = 255;
		}
		expect(countMask(suggestCleanMask({ width: 40, height: 30, data: allWhite }, { x: 20, y: 15 }))).toBe(0);
	});
});
