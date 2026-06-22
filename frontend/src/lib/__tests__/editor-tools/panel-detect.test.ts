import { describe, expect, it } from "vitest";
import { detectPanels, type ImageDataLike, type Rect } from "$lib/editor-tools/panel-detect.ts";

type Point = { x: number; y: number };

const BLACK = 0;
const WHITE = 255;
const OPAQUE = 255;

function makeWhitePage(width: number, height: number): Uint8ClampedArray {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let index = 0; index < width * height; index += 1) {
		const offset = index * 4;
		data[offset] = WHITE;
		data[offset + 1] = WHITE;
		data[offset + 2] = WHITE;
		data[offset + 3] = OPAQUE;
	}
	return data;
}

function makeFramedPage(width: number, height: number, panels: Rect[], stroke = 4): ImageDataLike {
	const data = makeWhitePage(width, height);
	for (const panel of panels) drawRectFrame(data, width, height, panel, stroke);
	return { width, height, data };
}

function makeSkewedFramedPage(width: number, height: number, panels: Point[][], stroke = 4): ImageDataLike {
	const data = makeWhitePage(width, height);
	for (const panel of panels) drawPolygonFrame(data, width, height, panel, stroke);
	return { width, height, data };
}

function gridPanels(width: number, height: number, margin: number, gutterX: number, gutterY: number): Rect[] {
	const panelWidth = Math.floor((width - margin * 2 - gutterX) / 2);
	const panelHeight = Math.floor((height - margin * 2 - gutterY) / 2);
	const left = margin;
	const right = margin + panelWidth + gutterX;
	const top = margin;
	const bottom = margin + panelHeight + gutterY;
	return [
		{ x: left, y: top, w: panelWidth, h: panelHeight },
		{ x: right, y: top, w: panelWidth, h: panelHeight },
		{ x: left, y: bottom, w: panelWidth, h: panelHeight },
		{ x: right, y: bottom, w: panelWidth, h: panelHeight },
	];
}

function drawRectFrame(data: Uint8ClampedArray, imageWidth: number, imageHeight: number, rect: Rect, stroke: number): void {
	for (let y = rect.y; y < rect.y + rect.h; y += 1) {
		for (let x = rect.x; x < rect.x + rect.w; x += 1) {
			const isFrame =
				x < rect.x + stroke ||
				x >= rect.x + rect.w - stroke ||
				y < rect.y + stroke ||
				y >= rect.y + rect.h - stroke;
			if (isFrame) paintBlack(data, imageWidth, imageHeight, x, y);
		}
	}
}

function drawPolygonFrame(data: Uint8ClampedArray, imageWidth: number, imageHeight: number, points: Point[], stroke: number): void {
	for (let index = 0; index < points.length; index += 1) {
		drawThickLine(data, imageWidth, imageHeight, points[index], points[(index + 1) % points.length], stroke);
	}
}

function drawThickLine(
	data: Uint8ClampedArray,
	imageWidth: number,
	imageHeight: number,
	start: Point,
	end: Point,
	stroke: number,
): void {
	const steps = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y));
	const radius = Math.floor(stroke / 2);
	for (let step = 0; step <= steps; step += 1) {
		const ratio = steps === 0 ? 0 : step / steps;
		const x = Math.round(start.x + (end.x - start.x) * ratio);
		const y = Math.round(start.y + (end.y - start.y) * ratio);
		for (let dy = -radius; dy <= radius; dy += 1) {
			for (let dx = -radius; dx <= radius; dx += 1) {
				paintBlack(data, imageWidth, imageHeight, x + dx, y + dy);
			}
		}
	}
}

function paintBlack(data: Uint8ClampedArray, imageWidth: number, imageHeight: number, x: number, y: number): void {
	if (x < 0 || x >= imageWidth || y < 0 || y >= imageHeight) return;
	const offset = (y * imageWidth + x) * 4;
	data[offset] = BLACK;
	data[offset + 1] = BLACK;
	data[offset + 2] = BLACK;
	data[offset + 3] = OPAQUE;
}

function boundsFor(points: Point[]): Rect {
	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	const minX = Math.min(...xs);
	const minY = Math.min(...ys);
	const maxX = Math.max(...xs);
	const maxY = Math.max(...ys);
	return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function expectRectsCloseTo(actual: Rect[], expected: Rect[], tolerance = 3): void {
	expect(actual).toHaveLength(expected.length);
	for (let index = 0; index < expected.length; index += 1) {
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

describe("detectPanels synthetic manga and webtoon pages", () => {
	it.each([
		{ label: "narrow", width: 320, height: 420, margin: 12, gutterX: 5, gutterY: 7 },
		{ label: "wide", width: 360, height: 460, margin: 16, gutterX: 70, gutterY: 64 },
	])("detects a 2x2 manga grid with $label gutters in right-to-left row order", ({ width, height, margin, gutterX, gutterY }) => {
		const [topLeft, topRight, bottomLeft, bottomRight] = gridPanels(width, height, margin, gutterX, gutterY);
		const image = makeFramedPage(width, height, [topLeft, topRight, bottomLeft, bottomRight]);

		const panels = detectPanels(image);

		expectRectsCloseTo(panels, [topRight, topLeft, bottomRight, bottomLeft]);
	});

	it("returns bounding boxes for slightly skewed manga panels without losing manga order", () => {
		const leftPanel = [
			{ x: 18, y: 22 },
			{ x: 140, y: 18 },
			{ x: 146, y: 182 },
			{ x: 14, y: 186 },
		];
		const rightPanel = [
			{ x: 176, y: 18 },
			{ x: 294, y: 22 },
			{ x: 298, y: 186 },
			{ x: 170, y: 182 },
		];
		const image = makeSkewedFramedPage(320, 210, [leftPanel, rightPanel], 5);

		const panels = detectPanels(image);

		expectRectsCloseTo(panels, [boundsFor(rightPanel), boundsFor(leftPanel)], 7);
	});

	it("keeps a full-page single panel when the page has no internal gutter", () => {
		const panel = { x: 0, y: 0, w: 240, h: 360 };
		const image = makeFramedPage(240, 360, [panel], 5);

		const panels = detectPanels(image);

		expectRectsCloseTo(panels, [panel]);
	});

	it("detects a long vertical webtoon strip as top-to-bottom stacked panels", () => {
		const width = 240;
		const margin = 12;
		const gutter = 18;
		const panelWidth = width - margin * 2;
		const panelHeights = [220, 300, 260, 330];
		let y = margin;
		const panels = panelHeights.map((height) => {
			const panel = { x: margin, y, w: panelWidth, h: height };
			y += height + gutter;
			return panel;
		});
		const image = makeFramedPage(width, y - gutter + margin, panels, 4);

		const detected = detectPanels(image);

		expectRectsCloseTo(detected, panels);
	});
});
