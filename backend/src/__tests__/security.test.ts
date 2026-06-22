// Tests for security utility functions

import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import {
	safePath,
	isValidProjectId,
	isValidImageId,
	sanitizeFilename,
	clampCrop,
} from "../utils/security.js";

describe("safePath", () => {
	const base = resolve("test-data/projects");

	test("normal path stays within base", () => {
		const result = safePath(base, "abc-123", "images", "test.png");
		expect(result).toContain("abc-123");
		expect(result).toContain("test.png");
	});

	test("path traversal with ../ is rejected", () => {
		expect(() => safePath(base, "../../etc", "passwd")).toThrow(/traversal/i);
	});

	test("path traversal with ..\\ is rejected", () => {
		expect(() => safePath(base, "..\\..\\etc", "passwd")).toThrow(/traversal/i);
	});

	test("empty segments are safe", () => {
		const result = safePath(base, "project-1");
		expect(result).toContain("project-1");
		expect(result.startsWith(base)).toBe(true);
	});
});

describe("isValidProjectId", () => {
	test("valid UUID v4 is accepted", () => {
		expect(isValidProjectId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
	});

	test("uppercase UUID is accepted", () => {
		expect(isValidProjectId("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
	});

	test("path traversal is rejected", () => {
		expect(isValidProjectId("../../etc/passwd")).toBe(false);
	});

	test("empty string is rejected", () => {
		expect(isValidProjectId("")).toBe(false);
	});

	test("random string is rejected", () => {
		expect(isValidProjectId("not-a-uuid")).toBe(false);
	});

	test("UUID with extra chars is rejected", () => {
		expect(isValidProjectId("550e8400-e29b-41d4-a716-446655440000-extra")).toBe(false);
	});
});

describe("isValidImageId", () => {
	test("UUID with .png extension is accepted", () => {
		expect(isValidImageId("550e8400-e29b-41d4-a716-446655440000.png")).toBe(true);
	});

	test("UUID with .jpg extension is accepted", () => {
		expect(isValidImageId("550e8400-e29b-41d4-a716-446655440000.jpg")).toBe(true);
	});

	test("UUID with .jpeg extension is accepted", () => {
		expect(isValidImageId("550e8400-e29b-41d4-a716-446655440000.jpeg")).toBe(true);
	});

	test("UUID with .webp extension is accepted", () => {
		expect(isValidImageId("550e8400-e29b-41d4-a716-446655440000.webp")).toBe(true);
	});

	test("result image ID is accepted", () => {
		expect(isValidImageId("result_550e8400-e29b-41d4-a716-446655440000.png")).toBe(true);
	});

	test("legacy safe image filename is accepted for restored prototype projects", () => {
		expect(isValidImageId("image-01.webp")).toBe(true);
		expect(isValidImageId("page 001-final.png")).toBe(true);
	});

	test("path traversal in image ID is rejected", () => {
		expect(isValidImageId("../../etc/passwd")).toBe(false);
	});

	test("legacy image filename with traversal-looking segments is rejected", () => {
		expect(isValidImageId("image..01.webp")).toBe(false);
		expect(isValidImageId(".hidden.webp")).toBe(false);
	});

	test("executable extension is rejected", () => {
		expect(isValidImageId("550e8400-e29b-41d4-a716-446655440000.exe")).toBe(false);
	});

	test("no extension is rejected", () => {
		expect(isValidImageId("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
	});
});

describe("sanitizeFilename", () => {
	test("normal filename passes through", () => {
		expect(sanitizeFilename("image.png")).toBe("image.png");
	});

	test("path separators are removed", () => {
		const result = sanitizeFilename("../../../etc/passwd");
		expect(result).not.toContain("/");
		expect(result).not.toContain("\\");
	});

	test("special characters are removed", () => {
		const result = sanitizeFilename('file<>:"/\\|?*.txt');
		expect(result).not.toContain("<");
		expect(result).not.toContain(">");
		expect(result).not.toContain(":");
		expect(result).not.toContain('"');
		expect(result).not.toContain("/");
		expect(result).not.toContain("\\");
		expect(result).not.toContain("|");
		expect(result).not.toContain("?");
		expect(result).not.toContain("*");
	});

	test("long filename is truncated to 255 chars", () => {
		const longName = "a".repeat(300) + ".png";
		expect(sanitizeFilename(longName).length).toBe(255);
	});

	test("null bytes are removed", () => {
		expect(sanitizeFilename("file\x00name.png")).toBe("file_name.png");
	});
});

describe("clampCrop", () => {
	test("normal crop within bounds is unchanged", () => {
		const result = clampCrop({ x: 10, y: 20, w: 100, h: 200 }, 1000, 1000);
		expect(result).toEqual({ x: 10, y: 20, w: 100, h: 200 });
	});

	test("negative coordinates are clamped to 0", () => {
		const result = clampCrop({ x: -10, y: -20, w: 100, h: 200 }, 1000, 1000);
		expect(result.x).toBe(0);
		expect(result.y).toBe(0);
	});

	test("crop exceeding image bounds is clamped", () => {
		const result = clampCrop({ x: 900, y: 900, w: 200, h: 200 }, 1000, 1000);
		expect(result.w).toBe(100); // 1000 - 900
		expect(result.h).toBe(100); // 1000 - 900
	});

	test("zero dimensions are clamped to minimum 1", () => {
		const result = clampCrop({ x: 0, y: 0, w: 0, h: 0 }, 1000, 1000);
		expect(result.w).toBe(1);
		expect(result.h).toBe(1);
	});

	test("decimal values are floored", () => {
		const result = clampCrop({ x: 10.7, y: 20.3, w: 100.9, h: 200.1 }, 1000, 1000);
		expect(result.x).toBe(10);
		expect(result.y).toBe(20);
	});

	// Regression: an out-of-bounds origin must be clamped INTO the image, and the
	// resulting region must always be extractable by sharp (x+w<=maxW, w>=1).
	// Previously clampCrop left x>=maxW intact, producing left+width>maxW and a
	// "bad extract area" throw on a paid AI job (P2).
	test("x >= maxW is clamped to maxW-1 and stays in bounds", () => {
		const result = clampCrop({ x: 5000, y: 0, w: 100, h: 100 }, 1000, 800);
		expect(result.x).toBe(999); // maxW - 1
		expect(result.w).toBe(1); // only 1px of room left
		expect(result.x + result.w).toBeLessThanOrEqual(1000);
		expect(result.y + result.h).toBeLessThanOrEqual(800);
	});

	test("y >= maxH is clamped to maxH-1 and stays in bounds", () => {
		const result = clampCrop({ x: 0, y: 5000, w: 100, h: 100 }, 1000, 800);
		expect(result.y).toBe(799); // maxH - 1
		expect(result.h).toBe(1);
		expect(result.x + result.w).toBeLessThanOrEqual(1000);
		expect(result.y + result.h).toBeLessThanOrEqual(800);
	});

	test("both x and y out of bounds are clamped in bounds", () => {
		const result = clampCrop({ x: 9999, y: 9999, w: 9999, h: 9999 }, 1000, 800);
		expect(result.x).toBe(999);
		expect(result.y).toBe(799);
		expect(result.w).toBe(1);
		expect(result.h).toBe(1);
		expect(result.x + result.w).toBeLessThanOrEqual(1000);
		expect(result.y + result.h).toBeLessThanOrEqual(800);
	});

	test("x exactly at maxW-1 yields a 1px-wide in-bounds region", () => {
		const result = clampCrop({ x: 999, y: 100, w: 50, h: 50 }, 1000, 800);
		expect(result.x).toBe(999);
		expect(result.w).toBe(1);
		expect(result.x + result.w).toBe(1000);
	});

	test("float out-of-bounds origin floors then clamps in bounds", () => {
		const result = clampCrop({ x: 1500.9, y: 1200.4, w: 10.6, h: 10.2 }, 1000, 800);
		expect(result.x).toBe(999);
		expect(result.y).toBe(799);
		expect(result.w).toBe(1);
		expect(result.h).toBe(1);
		expect(result.x + result.w).toBeLessThanOrEqual(1000);
		expect(result.y + result.h).toBeLessThanOrEqual(800);
	});

	// Degenerate image: callers pass `metadata.width ?? 1` (>=1) so 0 is not reached
	// in practice, but the function must still return a non-negative, in-bounds
	// region rather than a negative extent that would crash sharp.
	test("zero-size image (maxW=0/maxH=0) collapses to a zero region, never negative", () => {
		const result = clampCrop({ x: 100, y: 100, w: 50, h: 50 }, 0, 0);
		expect(result.x).toBe(0);
		expect(result.y).toBe(0);
		expect(result.w).toBe(0);
		expect(result.h).toBe(0);
	});

	test("1x1 image clamps any crop to the single pixel", () => {
		const result = clampCrop({ x: 999, y: 999, w: 999, h: 999 }, 1, 1);
		expect(result).toEqual({ x: 0, y: 0, w: 1, h: 1 });
	});

	// Invariant sweep: for any reasonable crop/image, the result is always a valid
	// sharp extract region (origin in bounds, size >= 1 when the axis has room,
	// origin+size never past the edge).
	test("result is always an extractable in-bounds region (invariant sweep)", () => {
		const dims = [1, 2, 50, 1000];
		const coords = [-5, 0, 1, 49, 999, 5000];
		for (const maxW of dims) {
			for (const maxH of dims) {
				for (const x of coords) {
					for (const y of coords) {
						const r = clampCrop({ x, y, w: 9999, h: 9999 }, maxW, maxH);
						expect(r.x).toBeGreaterThanOrEqual(0);
						expect(r.y).toBeGreaterThanOrEqual(0);
						expect(r.w).toBeGreaterThanOrEqual(1);
						expect(r.h).toBeGreaterThanOrEqual(1);
						expect(r.x + r.w).toBeLessThanOrEqual(maxW);
						expect(r.y + r.h).toBeLessThanOrEqual(maxH);
					}
				}
			}
		}
	});
});
