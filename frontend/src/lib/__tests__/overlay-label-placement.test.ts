import { describe, expect, it } from "vitest";
import {
	buildCanvasOverlayLabelPlacements,
	formatCanvasOverlayLabelStyle,
} from "$lib/editor/overlay-label-placement.js";

describe("overlay label placement", () => {
	it("moves colliding labels to separate slots", () => {
		const placements = buildCanvasOverlayLabelPlacements([
			{
				id: "a",
				label: "Empty text",
				box: { left: 100, top: 100, width: 80, height: 40 },
				preferredSide: "above",
			},
			{
				id: "b",
				label: "Comment",
				box: { left: 108, top: 104, width: 80, height: 40 },
				preferredSide: "above",
			},
		]);

		expect(placements.a.relativeTop).not.toBe(placements.b.relativeTop);
	});

	it("keeps labels inside the viewport when the preferred side would overflow", () => {
		const placements = buildCanvasOverlayLabelPlacements(
			[
				{
					id: "top",
					label: "Review",
					box: { left: 20, top: 3, width: 80, height: 40 },
					preferredSide: "above",
				},
			],
			{ viewportWidth: 320, viewportHeight: 240 },
		);

		expect(placements.top.side).toBe("below");
		expect(placements.top.relativeTop).toBeGreaterThan(0);
	});

	it("prefers selected labels first so focus labels stay near their region", () => {
		const placements = buildCanvasOverlayLabelPlacements([
			{
				id: "passive",
				label: "Comment",
				box: { left: 100, top: 100, width: 90, height: 45 },
				preferredSide: "above",
			},
			{
				id: "selected",
				label: "AI failed",
				box: { left: 104, top: 102, width: 90, height: 45 },
				selected: true,
				preferredSide: "below",
			},
		]);

		expect(placements.selected.side).toBe("above");
		expect(placements.passive.relativeTop).not.toBe(placements.selected.relativeTop);
	});

	it("supports overlay lanes so different systems do not place labels in the same slot", () => {
		const box = { left: 100, top: 100, width: 220, height: 80 };
		const placements = buildCanvasOverlayLabelPlacements([
			{
				id: "qc",
				label: "Empty text",
				box,
				laneIndex: 0,
				preferredSide: "above",
			},
			{
				id: "comment",
				label: "Comment",
				box,
				laneIndex: 1,
				preferredAlign: "right",
				preferredSide: "above",
			},
		]);

		expect(placements.comment.relativeTop).toBeLessThan(placements.qc.relativeTop);
		expect(placements.comment.align).toBe("right");
	});

	it("formats placement values as CSS custom properties", () => {
		const placements = buildCanvasOverlayLabelPlacements([
			{
				id: "label",
				label: "QC",
				box: { left: 100, top: 100, width: 90, height: 45 },
			},
		]);

		expect(formatCanvasOverlayLabelStyle(placements.label)).toContain("--overlay-label-left:");
		expect(formatCanvasOverlayLabelStyle(placements.label)).toContain("--overlay-label-top:");
		expect(formatCanvasOverlayLabelStyle(placements.label)).toContain("--overlay-label-width:");
	});
});
