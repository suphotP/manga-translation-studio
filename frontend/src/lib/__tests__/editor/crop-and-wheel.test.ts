import { describe, it, expect, vi } from "vitest";
import { capCropToMaxDimensions, classifyWheelGesture } from "$lib/canvas/editor.ts";

// editor.ts reads $lib/config.js at module load; provide a minimal stub.
vi.mock("$lib/config.js", () => ({
	config: {
		defaultFontFamily: "Tahoma, sans-serif",
		defaultFontSize: 24,
		defaultText: "ข้อความ",
		canvas: { minZoom: 0.1, maxZoom: 5 },
	},
}));

describe("capCropToMaxDimensions — aspect-preserving AI crop cap", () => {
	it("leaves a region within both caps untouched", () => {
		expect(capCropToMaxDimensions(500, 400, 1024, 1024)).toEqual({ width: 500, height: 400 });
	});

	it("preserves aspect ratio when WIDTH exceeds the cap", () => {
		const out = capCropToMaxDimensions(2048, 1024, 1024, 1024);
		expect(out.width).toBe(1024);
		// height scaled by the same 0.5 factor → no horizontal squash
		expect(out.height).toBe(512);
		expect(out.width / out.height).toBeCloseTo(2048 / 1024, 6);
	});

	it("preserves aspect ratio when HEIGHT exceeds the cap (the previously-broken case)", () => {
		const out = capCropToMaxDimensions(1024, 2048, 1024, 1024);
		expect(out.height).toBe(1024);
		expect(out.width).toBe(512);
		expect(out.width / out.height).toBeCloseTo(1024 / 2048, 6);
	});

	it("preserves aspect ratio when BOTH dimensions exceed the cap", () => {
		const w = 3000;
		const h = 2000;
		const out = capCropToMaxDimensions(w, h, 1024, 1024);
		// limiting axis is width (3000 > 2000); scale = 1024/3000
		expect(out.width).toBeCloseTo(1024, 6);
		expect(out.height).toBeCloseTo(2000 * (1024 / 3000), 6);
		// ratio is unchanged → not stretched/squashed
		expect(out.width / out.height).toBeCloseTo(w / h, 6);
		// both within cap
		expect(out.width).toBeLessThanOrEqual(1024 + 1e-6);
		expect(out.height).toBeLessThanOrEqual(1024 + 1e-6);
	});

	it("handles zero / non-finite dimensions safely", () => {
		expect(capCropToMaxDimensions(0, 100, 1024, 1024)).toEqual({ width: 0, height: 100 });
		expect(capCropToMaxDimensions(Number.NaN, 100, 1024, 1024)).toEqual({ width: 0, height: 100 });
	});
});

describe("classifyWheelGesture — trackpad pinch routes to zoom", () => {
	it("treats ctrlKey wheel (macOS/trackpad pinch) as ZOOM", () => {
		expect(classifyWheelGesture({ ctrlKey: true })).toBe("zoom");
	});

	it("treats altKey wheel (explicit zoom modifier) as ZOOM", () => {
		expect(classifyWheelGesture({ altKey: true })).toBe("zoom");
	});

	it("treats a plain wheel (no modifier) as PAN", () => {
		expect(classifyWheelGesture({})).toBe("pan");
		expect(classifyWheelGesture({ ctrlKey: false, altKey: false })).toBe("pan");
	});

	it("treats a horizontal swipe (no zoom modifier) as PAN", () => {
		expect(classifyWheelGesture({ ctrlKey: false })).toBe("pan");
	});
});
