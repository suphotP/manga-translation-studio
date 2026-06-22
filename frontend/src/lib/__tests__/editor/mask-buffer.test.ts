// W3.13 — MaskBuffer unit tests.

import { describe, it, expect } from "vitest";
import { MaskBuffer, modeFromModifiers } from "$lib/editor/tools/mask-buffer.ts";

function filledRegion(width: number, height: number, x0: number, y0: number, x1: number, y1: number) {
	const buf = new Uint8ClampedArray(width * height);
	for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) buf[y * width + x] = 255;
	return buf;
}

describe("MaskBuffer", () => {
	it("starts empty and tracks dimensions on resize", () => {
		const m = new MaskBuffer();
		m.resize(10, 8);
		expect(m.width).toBe(10);
		expect(m.height).toBe(8);
		expect(m.data.length).toBe(80);
		expect(m.isEmpty()).toBe(true);
		expect(m.countSelected()).toBe(0);
	});

	it("composite replace sets the mask and computes tight bounds", () => {
		const m = new MaskBuffer();
		m.resize(8, 8);
		m.composite(filledRegion(8, 8, 2, 3, 5, 6), "replace");
		expect(m.isEmpty()).toBe(false);
		expect(m.countSelected()).toBe(3 * 3);
		expect(m.getBounds()).toEqual({ minX: 2, minY: 3, maxX: 4, maxY: 5 });
	});

	it("add mode is a union (max) of selections", () => {
		const m = new MaskBuffer();
		m.resize(8, 8);
		m.composite(filledRegion(8, 8, 0, 0, 3, 3), "replace");
		m.composite(filledRegion(8, 8, 5, 5, 8, 8), "add");
		expect(m.countSelected()).toBe(9 + 9);
		expect(m.getBounds()).toEqual({ minX: 0, minY: 0, maxX: 7, maxY: 7 });
	});

	it("subtract mode removes overlap", () => {
		const m = new MaskBuffer();
		m.resize(8, 8);
		m.composite(filledRegion(8, 8, 0, 0, 6, 6), "replace");
		m.composite(filledRegion(8, 8, 3, 3, 6, 6), "subtract");
		expect(m.at(1, 1)).toBe(255);
		expect(m.at(4, 4)).toBe(0);
	});

	it("intersect mode keeps only the overlap (min)", () => {
		const m = new MaskBuffer();
		m.resize(8, 8);
		m.composite(filledRegion(8, 8, 0, 0, 5, 5), "replace");
		m.composite(filledRegion(8, 8, 3, 3, 8, 8), "intersect");
		expect(m.at(1, 1)).toBe(0);
		expect(m.at(4, 4)).toBe(255);
		expect(m.getBounds()).toEqual({ minX: 3, minY: 3, maxX: 4, maxY: 4 });
	});

	it("selectAll / clear toggle the whole buffer", () => {
		const m = new MaskBuffer();
		m.resize(4, 4);
		m.selectAll();
		expect(m.countSelected()).toBe(16);
		expect(m.isEmpty()).toBe(false);
		m.clear();
		expect(m.countSelected()).toBe(0);
		expect(m.isEmpty()).toBe(true);
	});

	it("emits change events on mutation", () => {
		const m = new MaskBuffer();
		m.resize(4, 4);
		let calls = 0;
		const off = m.onChange(() => calls++);
		m.composite(filledRegion(4, 4, 0, 0, 2, 2), "replace");
		m.clear();
		off();
		m.selectAll();
		expect(calls).toBe(2); // listener removed before selectAll
	});

	it("rejects mismatched composite/setData lengths", () => {
		const m = new MaskBuffer();
		m.resize(4, 4);
		expect(() => m.composite(new Uint8ClampedArray(4), "replace")).toThrow();
		expect(() => m.setData(new Uint8ClampedArray(4))).toThrow();
	});

	it("toRGBA mirrors mask alpha", () => {
		const m = new MaskBuffer();
		m.resize(2, 1);
		m.composite(new Uint8ClampedArray([255, 0]), "replace");
		const rgba = m.toRGBA([10, 20, 30]);
		expect([...rgba.slice(0, 4)]).toEqual([10, 20, 30, 255]);
		expect(rgba[7]).toBe(0); // second pixel alpha
	});
});

describe("modeFromModifiers", () => {
	it("maps Photoshop modifier semantics", () => {
		expect(modeFromModifiers({})).toBe("replace");
		expect(modeFromModifiers({ shiftKey: true })).toBe("add");
		expect(modeFromModifiers({ altKey: true })).toBe("subtract");
		expect(modeFromModifiers({ shiftKey: true, altKey: true })).toBe("intersect");
	});
});
