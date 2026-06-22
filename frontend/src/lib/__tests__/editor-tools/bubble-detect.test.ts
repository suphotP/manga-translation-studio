import { describe, expect, it } from "vitest";
import { detectBubbles, suggestCleanMask, type BubbleCandidate } from "$lib/editor-tools/bubble-detect.ts";

type Rgba = readonly [number, number, number, number];

interface TestImage {
	readonly width: number;
	readonly height: number;
	readonly data: Uint8ClampedArray;
}

const BACKGROUND: Rgba = [172, 172, 166, 255];
const WHITE: Rgba = [255, 255, 255, 255];
const INK: Rgba = [18, 18, 18, 255];

function makeImage(width: number, height: number, fill: Rgba = BACKGROUND): TestImage {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) setPixel({ width, height, data }, x, y, fill);
	}
	return { width, height, data };
}

function setPixel(image: TestImage, x: number, y: number, rgba: Rgba): void {
	if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
	const offset = (y * image.width + x) * 4;
	image.data[offset] = rgba[0];
	image.data[offset + 1] = rgba[1];
	image.data[offset + 2] = rgba[2];
	image.data[offset + 3] = rgba[3];
}

function fillRect(image: TestImage, x0: number, y0: number, width: number, height: number, rgba: Rgba): void {
	for (let y = y0; y < y0 + height; y++) {
		for (let x = x0; x < x0 + width; x++) setPixel(image, x, y, rgba);
	}
}

function drawPanelNoise(image: TestImage): void {
	for (let y = 8; y < image.height; y += 17) fillRect(image, 0, y, image.width, 1, [132, 132, 128, 255]);
	for (let x = 12; x < image.width; x += 31) fillRect(image, x, 0, 1, image.height, [118, 118, 114, 255]);
}

function drawEllipseBubble(image: TestImage, cx: number, cy: number, rx: number, ry: number): void {
	for (let y = Math.floor(cy - ry - 2); y <= Math.ceil(cy + ry + 2); y++) {
		for (let x = Math.floor(cx - rx - 2); x <= Math.ceil(cx + rx + 2); x++) {
			const nx = (x + 0.5 - cx) / rx;
			const ny = (y + 0.5 - cy) / ry;
			const d = nx * nx + ny * ny;
			if (d <= 1.2 && d > 0.78) setPixel(image, x, y, INK);
			if (d <= 0.78) setPixel(image, x, y, WHITE);
		}
	}
	drawInkText(image, cx - 7, cy - 3);
}

function drawRectBubble(image: TestImage, x: number, y: number, width: number, height: number): void {
	fillRect(image, x, y, width, height, INK);
	fillRect(image, x + 2, y + 2, width - 4, height - 4, WHITE);
	drawInkText(image, x + Math.floor(width / 2) - 6, y + Math.floor(height / 2) - 3);
}

function drawDiamondBubble(image: TestImage, cx: number, cy: number, rx: number, ry: number): void {
	for (let y = Math.floor(cy - ry - 2); y <= Math.ceil(cy + ry + 2); y++) {
		for (let x = Math.floor(cx - rx - 2); x <= Math.ceil(cx + rx + 2); x++) {
			const distance = Math.abs((x + 0.5 - cx) / rx) + Math.abs((y + 0.5 - cy) / ry);
			if (distance <= 1.12 && distance > 0.84) setPixel(image, x, y, INK);
			if (distance <= 0.84) setPixel(image, x, y, WHITE);
		}
	}
	drawInkText(image, cx - 7, cy - 3);
}

function drawEdgeBubble(image: TestImage): void {
	fillRect(image, 0, 18, 35, 31, WHITE);
	fillRect(image, 33, 18, 2, 31, INK);
	fillRect(image, 0, 18, 35, 2, INK);
	fillRect(image, 0, 47, 35, 2, INK);
	fillRect(image, 2, 20, 31, 27, WHITE);
	fillRect(image, 0, 24, 2, 17, WHITE);
	drawInkText(image, 11, 31);
}

function drawInkText(image: TestImage, x: number, y: number): void {
	fillRect(image, x, y, 14, 2, INK);
	fillRect(image, x + 2, y + 4, 10, 2, INK);
	fillRect(image, x + 5, y - 2, 2, 12, INK);
}

function maskAt(mask: Uint8Array, width: number, x: number, y: number): number {
	return mask[y * width + x];
}

function maskCount(mask: Uint8Array): number {
	let count = 0;
	for (const value of mask) {
		if (value) count++;
	}
	return count;
}

function candidateContaining(candidates: BubbleCandidate[], width: number, x: number, y: number): BubbleCandidate {
	const candidate = candidates.find((item) => maskAt(item.mask, width, x, y) === 255);
	expect(candidate, `expected a candidate mask to contain (${x}, ${y})`).toBeDefined();
	return candidate as BubbleCandidate;
}

describe("detectBubbles", () => {
	it("detects white black-bordered bubbles across multiple synthetic shapes", () => {
		const image = makeImage(180, 120);
		drawPanelNoise(image);
		drawEllipseBubble(image, 42, 36, 24, 17);
		drawRectBubble(image, 92, 18, 42, 29);
		drawDiamondBubble(image, 132, 82, 24, 20);

		const candidates = detectBubbles(image);

		expect(candidates).toHaveLength(3);
		for (const candidate of candidates) {
			expect(candidate.mask).toHaveLength(image.width * image.height);
			expect(candidate.score).toBeGreaterThanOrEqual(0.48);
		}
		const ellipse = candidateContaining(candidates, image.width, 42, 36);
		const rectangle = candidateContaining(candidates, image.width, 113, 32);
		const diamond = candidateContaining(candidates, image.width, 132, 82);

		expect(ellipse.bounds.x).toBeLessThanOrEqual(22);
		expect(ellipse.bounds.y).toBeLessThanOrEqual(23);
		expect(ellipse.bounds.width).toBeGreaterThanOrEqual(40);
		expect(rectangle.bounds).toMatchObject({ x: 94, y: 20 });
		expect(diamond.bounds.x).toBeGreaterThanOrEqual(111);
	});

	it("fails closed when the image has no bright speech-bubble component", () => {
		const image = makeImage(96, 72);
		drawPanelNoise(image);
		fillRect(image, 22, 18, 16, 2, INK);
		fillRect(image, 50, 37, 24, 1, INK);

		expect(detectBubbles(image)).toEqual([]);
		expect(maskCount(suggestCleanMask(image, { x: 24, y: 18 }))).toBe(0);
	});

	it("detects a bubble whose bright region touches the image edge", () => {
		const image = makeImage(80, 72);
		drawEdgeBubble(image);

		const candidates = detectBubbles(image);
		const edge = candidateContaining(candidates, image.width, 12, 34);
		const cleanMask = suggestCleanMask(image, { x: 12, y: 34 });

		expect(candidates).toHaveLength(1);
		expect(edge.bounds.x).toBe(0);
		expect(edge.bounds.y).toBe(20);
		expect(maskAt(edge.mask, image.width, 0, 34)).toBe(255);
		expect(maskAt(cleanMask, image.width, 0, 34)).toBe(255);
		expect(cleanMask).toHaveLength(image.width * image.height);
	});

	it("fills enclosed pinholes in both detected masks and click clean masks", () => {
		const image = makeImage(90, 70);
		drawRectBubble(image, 20, 15, 48, 34);
		setPixel(image, 43, 28, INK);
		setPixel(image, 44, 28, INK);
		setPixel(image, 43, 29, INK);
		setPixel(image, 44, 29, INK);

		const [candidate] = detectBubbles(image);
		const cleanMask = suggestCleanMask(image, { x: 34, y: 31 });

		expect(candidate).toBeDefined();
		expect(maskAt(candidate.mask, image.width, 43, 28)).toBe(255);
		expect(maskAt(candidate.mask, image.width, 44, 29)).toBe(255);
		expect(maskAt(cleanMask, image.width, 43, 28)).toBe(255);
		expect(maskAt(candidate.mask, image.width, 19, 14)).toBe(0);
	});
});
