import { describe, expect, it } from "vitest";
import {
	beginCloneStampStroke,
	createCloneStampState,
	endCloneStampStroke,
	setCloneStampSource,
	sourcePointForCloneStampTarget,
	stampCloneStroke,
	stampDab,
	stampStroke,
	type CloneStampBrush,
	type ImageDataLike,
} from "../clone-stamp.ts";

type Rgba = readonly [number, number, number, number];

const BLACK: Rgba = [0, 0, 0, 255];
const CLEAR: Rgba = [0, 0, 0, 0];
const HARD_ONE_PIXEL_BRUSH: CloneStampBrush = { size: 1, hardness: 1, opacity: 1 };

function makeImage(width: number, height: number, fill: Rgba = CLEAR): ImageDataLike {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let index = 0; index < width * height; index += 1) {
		const offset = index * 4;
		data[offset] = fill[0];
		data[offset + 1] = fill[1];
		data[offset + 2] = fill[2];
		data[offset + 3] = fill[3];
	}
	return { width, height, data };
}

function setPixel(image: ImageDataLike, x: number, y: number, rgba: Rgba): void {
	const offset = (y * image.width + x) * 4;
	image.data[offset] = rgba[0];
	image.data[offset + 1] = rgba[1];
	image.data[offset + 2] = rgba[2];
	image.data[offset + 3] = rgba[3];
}

function pixel(image: ImageDataLike, x: number, y: number): number[] {
	const offset = (y * image.width + x) * 4;
	return Array.from(image.data.slice(offset, offset + 4));
}

describe("stampDab", () => {
	it("copies the sampled source pixel to the target center", () => {
		const source = makeImage(5, 5, CLEAR);
		const target = makeImage(5, 5, BLACK);
		setPixel(source, 1, 1, [200, 40, 12, 255]);

		const result = stampDab(target, source, 1, 1, 3, 3, HARD_ONE_PIXEL_BRUSH);

		expect(result).toEqual({ pixelsWritten: 1, bounds: { x: 3, y: 3, width: 1, height: 1 } });
		expect(pixel(target, 3, 3)).toEqual([200, 40, 12, 255]);
		expect(pixel(target, 3, 2)).toEqual(Array.from(BLACK));
	});

	it("alpha-composites source alpha and brush opacity over the target", () => {
		const source = makeImage(1, 1, [255, 255, 255, 128]);
		const target = makeImage(1, 1, [0, 0, 0, 255]);

		stampDab(target, source, 0, 0, 0, 0, { size: 1, hardness: 1, opacity: 0.5 });

		expect(pixel(target, 0, 0)).toEqual([64, 64, 64, 255]);
	});

	it("uses hardness to create a soft falloff at the brush edge", () => {
		const source = makeImage(11, 11, [255, 255, 255, 255]);
		const target = makeImage(11, 11, BLACK);

		stampDab(target, source, 5, 5, 5, 5, { size: 8, hardness: 0.25, opacity: 1 });

		const center = pixel(target, 5, 5)[0];
		const nearEdge = pixel(target, 7, 5)[0];
		const outerEdge = pixel(target, 8, 5)[0];
		const outside = pixel(target, 10, 5)[0];
		expect(center).toBe(255);
		expect(nearEdge).toBeGreaterThan(outerEdge);
		expect(nearEdge).toBeLessThan(center);
		expect(outerEdge).toBeGreaterThan(0);
		expect(outside).toBe(0);
	});

	it("clips safely when the destination brush footprint crosses image bounds", () => {
		const source = makeImage(4, 4, [18, 52, 86, 255]);
		const target = makeImage(4, 4, BLACK);

		const result = stampDab(target, source, 0, 0, 0, 0, { size: 6, hardness: 1, opacity: 1 });

		expect(result.pixelsWritten).toBeGreaterThan(1);
		expect(result.bounds?.x).toBe(0);
		expect(result.bounds?.y).toBe(0);
		expect(result.bounds?.width).toBeLessThanOrEqual(4);
		expect(result.bounds?.height).toBeLessThanOrEqual(4);
		expect(pixel(target, 0, 0)).toEqual([18, 52, 86, 255]);
	});
});

describe("clone stamp state", () => {
	it("keeps a persistent source offset in aligned mode", () => {
		const state = createCloneStampState("aligned");
		setCloneStampSource(state, { x: 1, y: 1 });

		const firstStroke = beginCloneStampStroke(state, { x: 5, y: 5 });
		expect(firstStroke?.sourceStart).toEqual({ x: 1, y: 1 });
		expect(sourcePointForCloneStampTarget(state, { x: 7, y: 8 })).toEqual({ x: 3, y: 4 });
		endCloneStampStroke(state);

		const secondStroke = beginCloneStampStroke(state, { x: 10, y: 10 });
		expect(secondStroke?.sourceStart).toEqual({ x: 6, y: 6 });
		expect(sourcePointForCloneStampTarget(state, { x: 11, y: 10 })).toEqual({ x: 7, y: 6 });
	});

	it("restarts from the sampled source on every non-aligned stroke", () => {
		const state = createCloneStampState("non-aligned");
		setCloneStampSource(state, { x: 1, y: 1 });

		expect(beginCloneStampStroke(state, { x: 5, y: 5 })?.sourceStart).toEqual({ x: 1, y: 1 });
		expect(sourcePointForCloneStampTarget(state, { x: 7, y: 8 })).toEqual({ x: 3, y: 4 });
		endCloneStampStroke(state);

		expect(beginCloneStampStroke(state, { x: 10, y: 10 })?.sourceStart).toEqual({ x: 1, y: 1 });
		expect(sourcePointForCloneStampTarget(state, { x: 11, y: 10 })).toEqual({ x: 2, y: 1 });
	});

	it("does not stamp until Alt-click has set a source", () => {
		const source = makeImage(3, 3, [255, 255, 255, 255]);
		const target = makeImage(3, 3, BLACK);
		const state = createCloneStampState("aligned");

		const result = stampCloneStroke(target, source, state, [{ x: 1, y: 1 }], HARD_ONE_PIXEL_BRUSH);

		expect(result).toEqual({ dabs: 0, pixelsWritten: 0, bounds: null });
		expect(pixel(target, 1, 1)).toEqual(Array.from(BLACK));
	});
});

describe("stampStroke", () => {
	it("interpolates dabs using spacing as a percentage of brush size", () => {
		const source = makeImage(12, 6, CLEAR);
		const target = makeImage(12, 6, BLACK);
		for (let x = 0; x < source.width; x += 1) {
			setPixel(source, x, 3, [x * 20, 0, 0, 255]);
		}

		const result = stampStroke(
			target,
			source,
			{ x: 1, y: 3 },
			[
				{ x: 1, y: 1 },
				{ x: 9, y: 1 },
			],
			HARD_ONE_PIXEL_BRUSH,
			{ spacingPercent: 100 },
		);

		expect(result.dabs).toBe(9);
		expect(pixel(target, 1, 1)).toEqual([20, 0, 0, 255]);
		expect(pixel(target, 5, 1)).toEqual([100, 0, 0, 255]);
		expect(pixel(target, 9, 1)).toEqual([180, 0, 0, 255]);
		expect(pixel(target, 5, 2)).toEqual(Array.from(BLACK));
	});

	it("samples a stable source snapshot when source and target share the same buffer", () => {
		const image = makeImage(6, 1, CLEAR);
		for (let x = 0; x < image.width; x += 1) {
			setPixel(image, x, 0, [x * 40, 0, 0, 255]);
		}

		stampStroke(
			image,
			image,
			{ x: 0, y: 0 },
			[
				{ x: 1, y: 0 },
				{ x: 3, y: 0 },
			],
			HARD_ONE_PIXEL_BRUSH,
			{ spacingPercent: 100 },
		);

		expect(pixel(image, 1, 0)).toEqual([0, 0, 0, 255]);
		expect(pixel(image, 2, 0)).toEqual([40, 0, 0, 255]);
		expect(pixel(image, 3, 0)).toEqual([80, 0, 0, 255]);
	});

	it("clips source pixels that fall outside the sampled image", () => {
		const source = makeImage(3, 3, [255, 255, 255, 255]);
		const target = makeImage(5, 3, BLACK);

		const result = stampStroke(
			target,
			source,
			{ x: 0, y: 1 },
			[
				{ x: 1, y: 1 },
				{ x: 3, y: 1 },
			],
			HARD_ONE_PIXEL_BRUSH,
			{ spacingPercent: 100 },
		);

		expect(result.pixelsWritten).toBe(3);
		expect(pixel(target, 1, 1)).toEqual([255, 255, 255, 255]);
		expect(pixel(target, 2, 1)).toEqual([255, 255, 255, 255]);
		expect(pixel(target, 3, 1)).toEqual([255, 255, 255, 255]);
		expect(pixel(target, 4, 1)).toEqual(Array.from(BLACK));
	});
});
