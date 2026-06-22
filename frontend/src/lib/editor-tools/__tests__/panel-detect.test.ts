import { describe, expect, it } from "vitest";
import { detectPanels, type ImageDataLike, type Rect } from "../panel-detect.ts";

function makePage(width: number, height: number, panels: Rect[], stroke = 4): ImageDataLike {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let index = 0; index < width * height; index++) {
		const offset = index * 4;
		data[offset] = 255;
		data[offset + 1] = 255;
		data[offset + 2] = 255;
		data[offset + 3] = 255;
	}

	for (const panel of panels) drawPanelFrame(data, width, panel, stroke);
	return { width, height, data };
}

function drawPanelFrame(data: Uint8ClampedArray, imageWidth: number, rect: Rect, stroke: number): void {
	for (let y = rect.y; y < rect.y + rect.h; y++) {
		for (let x = rect.x; x < rect.x + rect.w; x++) {
			const isFrame =
				x < rect.x + stroke ||
				x >= rect.x + rect.w - stroke ||
				y < rect.y + stroke ||
				y >= rect.y + rect.h - stroke;
			if (!isFrame) continue;
			const offset = (y * imageWidth + x) * 4;
			data[offset] = 0;
			data[offset + 1] = 0;
			data[offset + 2] = 0;
			data[offset + 3] = 255;
		}
	}
}

function rectsCloseTo(actual: Rect[], expected: Rect[], tolerance = 1): void {
	expect(actual).toHaveLength(expected.length);
	for (let index = 0; index < expected.length; index++) {
		expect(actual[index].x).toBeGreaterThanOrEqual(expected[index].x - tolerance);
		expect(actual[index].x).toBeLessThanOrEqual(expected[index].x + tolerance);
		expect(actual[index].y).toBeGreaterThanOrEqual(expected[index].y - tolerance);
		expect(actual[index].y).toBeLessThanOrEqual(expected[index].y + tolerance);
		expect(actual[index].w).toBeGreaterThanOrEqual(expected[index].w - tolerance);
		expect(actual[index].w).toBeLessThanOrEqual(expected[index].w + tolerance);
		expect(actual[index].h).toBeGreaterThanOrEqual(expected[index].h - tolerance);
		expect(actual[index].h).toBeLessThanOrEqual(expected[index].h + tolerance);
	}
}

describe("detectPanels", () => {
	it("detects a four-panel framed manga page in top-to-bottom, right-to-left order", () => {
		const topLeft = { x: 10, y: 10, w: 94, h: 134 };
		const topRight = { x: 116, y: 10, w: 94, h: 134 };
		const bottomLeft = { x: 10, y: 156, w: 94, h: 134 };
		const bottomRight = { x: 116, y: 156, w: 94, h: 134 };
		const image = makePage(220, 300, [topLeft, topRight, bottomLeft, bottomRight]);

		const panels = detectPanels(image);

		rectsCloseTo(panels, [topRight, topLeft, bottomRight, bottomLeft]);
	});

	it("can return left-to-right reading order for non-manga workflows", () => {
		const topLeft = { x: 10, y: 10, w: 94, h: 134 };
		const topRight = { x: 116, y: 10, w: 94, h: 134 };
		const bottomLeft = { x: 10, y: 156, w: 94, h: 134 };
		const bottomRight = { x: 116, y: 156, w: 94, h: 134 };
		const image = makePage(220, 300, [topLeft, topRight, bottomLeft, bottomRight]);

		const panels = detectPanels(image, { readingOrder: "ltr" });

		rectsCloseTo(panels, [topLeft, topRight, bottomLeft, bottomRight]);
	});

	it("recursively subdivides a six-panel page and preserves manga row order", () => {
		const row1Left = { x: 16, y: 16, w: 107, h: 101 };
		const row1Right = { x: 137, y: 16, w: 107, h: 101 };
		const row2Left = { x: 16, y: 129, w: 107, h: 101 };
		const row2Right = { x: 137, y: 129, w: 107, h: 101 };
		const row3Left = { x: 16, y: 242, w: 107, h: 101 };
		const row3Right = { x: 137, y: 242, w: 107, h: 101 };
		const image = makePage(260, 360, [row1Left, row1Right, row2Left, row2Right, row3Left, row3Right]);

		const panels = detectPanels(image);

		rectsCloseTo(panels, [row1Right, row1Left, row2Right, row2Left, row3Right, row3Left]);
	});

	it("returns one trimmed panel for a single framed page with outer margins", () => {
		const panel = { x: 28, y: 24, w: 164, h: 252 };
		const image = makePage(220, 320, [panel], 3);

		const panels = detectPanels(image);

		rectsCloseTo(panels, [panel]);
	});

	it("filters blank pages and tiny framed marks", () => {
		const blank = makePage(120, 160, []);
		const tinyOnly = makePage(160, 180, [{ x: 20, y: 20, w: 12, h: 12 }], 2);

		expect(detectPanels(blank)).toEqual([]);
		expect(detectPanels(tinyOnly)).toEqual([]);
	});

	it("returns an empty list for malformed image data", () => {
		expect(detectPanels(null)).toEqual([]);
		expect(detectPanels({ width: 20, height: 20, data: new Uint8ClampedArray(10) })).toEqual([]);
		expect(detectPanels({ width: 0, height: 20, data: new Uint8ClampedArray(400) })).toEqual([]);
	});
});
