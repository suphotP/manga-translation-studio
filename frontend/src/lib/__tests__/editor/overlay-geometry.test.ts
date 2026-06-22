import { describe, expect, it } from "vitest";
import { resultRegionPreviewStyle } from "$lib/editor/overlay-geometry.ts";

function parse(style: string): Record<string, string> {
	return Object.fromEntries(
		style
			.split(";")
			.filter(Boolean)
			.map((decl) => {
				const [prop, ...rest] = decl.split(":");
				return [prop.trim(), rest.join(":").trim()];
			}),
	);
}

describe("resultRegionPreviewStyle (AI result overlay region framing)", () => {
	it("scales+offsets a full-page result so only the crop region fills the box", () => {
		// Result image is the FULL page (800x1600). The marker edited a 120x80
		// region at (10,20). The overlay box for that region is 240x160 workspace
		// px. The full image must be scaled so the region maps onto the box, and
		// shifted so the region's top-left sits at the box top-left.
		const style = parse(
			resultRegionPreviewStyle(
				{ width: 240, height: 160 },
				{ x: 10, y: 20, w: 120, h: 80 },
				{ width: 800, height: 1600 },
			),
		);
		// scaleX = 240/120 = 2, scaleY = 160/80 = 2
		expect(style.width).toBe("1600px"); // 800 * 2
		expect(style.height).toBe("3200px"); // 1600 * 2
		expect(style.left).toBe("-20px"); // -(10 * 2)
		expect(style.top).toBe("-40px"); // -(20 * 2)
		expect(style.position).toBe("absolute");
		expect(style["object-fit"]).toBe("fill");
	});

	it("frames a region at the page origin with no offset", () => {
		const style = parse(
			resultRegionPreviewStyle(
				{ width: 100, height: 100 },
				{ x: 0, y: 0, w: 50, h: 50 },
				{ width: 200, height: 200 },
			),
		);
		expect(style.left).toBe("0px");
		expect(style.top).toBe("0px");
		expect(style.width).toBe("400px"); // 200 * (100/50)
	});

	it("returns empty for unusable inputs so the caller can hide the preview", () => {
		expect(resultRegionPreviewStyle({ width: 100, height: 100 }, { x: 0, y: 0, w: 0, h: 10 }, { width: 200, height: 200 })).toBe("");
		expect(resultRegionPreviewStyle({ width: 0, height: 100 }, { x: 0, y: 0, w: 10, h: 10 }, { width: 200, height: 200 })).toBe("");
		expect(resultRegionPreviewStyle({ width: 100, height: 100 }, { x: 0, y: 0, w: 10, h: 10 }, { width: 0, height: 0 })).toBe("");
	});
});
