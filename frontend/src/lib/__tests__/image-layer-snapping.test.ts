import { describe, expect, it } from "vitest";
import { snapImageLayerToImageGuides } from "$lib/editor/image-layer-snapping.js";

describe("image layer snapping", () => {
	it("snaps layer edges to the original image edges", () => {
		const result = snapImageLayerToImageGuides({
			layer: { x: 895, y: 5, w: 300, h: 140 },
			imageWidth: 1200,
			imageHeight: 800,
			thresholdX: 8,
			thresholdY: 8,
		});

		expect(result.x).toBe(900);
		expect(result.y).toBe(0);
		expect(result.guides).toEqual([
			{ orientation: "vertical", kind: "right", position: 1200 },
			{ orientation: "horizontal", kind: "top", position: 0 },
		]);
	});

	it("snaps layer centers to the original image center guides", () => {
		const result = snapImageLayerToImageGuides({
			layer: { x: 446, y: 332, w: 300, h: 140 },
			imageWidth: 1200,
			imageHeight: 800,
			thresholdX: 8,
			thresholdY: 8,
		});

		expect(result.x).toBe(450);
		expect(result.y).toBe(330);
		expect(result.guides).toEqual([
			{ orientation: "vertical", kind: "center-x", position: 600 },
			{ orientation: "horizontal", kind: "center-y", position: 400 },
		]);
	});

	it("does not move the layer outside the snap threshold", () => {
		const result = snapImageLayerToImageGuides({
			layer: { x: 430, y: 300, w: 300, h: 140 },
			imageWidth: 1200,
			imageHeight: 800,
			thresholdX: 8,
			thresholdY: 8,
		});

		expect(result).toEqual({
			x: 430,
			y: 300,
			guides: [],
		});
	});
});
