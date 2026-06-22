// Thai text wrapping tests

import { describe, it, expect } from "vitest";
import { wrapThaiText, findBestFontSize } from "$lib/canvas/thai-wrap";
import { vi } from "vitest";

const createMockContext = () => ({
	font: "",
	measureText: vi.fn((text: string) => ({ width: text.length * 10 })),
});

describe("Thai text wrapping", () => {
	describe("wrapThaiText", () => {
		it("handles short text that fits", () => {
			const ctx = createMockContext();
			const result = wrapThaiText(ctx, "abc", 100, 24, "Tahoma");
			expect(result).toEqual(["abc"]);
		});

		it("wraps text when it exceeds maxWidth", () => {
			const ctx = createMockContext();
			ctx.measureText.mockImplementation((t: string) => ({ width: t.length * 15 }));
			const result = wrapThaiText(ctx, "abcdefghij", 80, 24, "Tahoma");
			expect(result.length).toBeGreaterThan(1);
		});

		it("handles empty string", () => {
			const ctx = createMockContext();
			const result = wrapThaiText(ctx, "", 100, 24, "Tahoma");
			expect(result).toEqual([]);
		});

		it("handles text with numbers and spaces", () => {
			const ctx = createMockContext();
			ctx.measureText.mockImplementation((t: string) => ({ width: t.length * 5 }));
			const text = "price 500 baht";
			const result = wrapThaiText(ctx, text, 200, 24, "Tahoma");
			expect(result).toHaveLength(1);
			expect(result[0]).toBe(text);
		});

		it("handles very small maxWidth", () => {
			const ctx = createMockContext();
			const result = wrapThaiText(ctx, "abc", 10, 24, "Tahoma");
			expect(result.length).toBeGreaterThan(1);
		});
	});

	describe("findBestFontSize", () => {
		it("finds a font size that fits", () => {
			const ctx = createMockContext();
			ctx.measureText.mockImplementation((t: string) => ({ width: t.length * 3 }));
			const result = findBestFontSize(ctx, "abc", 100, 50, "Tahoma");
			expect(result).toBeGreaterThan(8);
		});

		it("returns >= 8 (minimum) for very long text", () => {
			const ctx = createMockContext();
			ctx.measureText.mockImplementation((t: string) => ({ width: t.length * 50 }));
			const longText = "a".repeat(200);
			const result = findBestFontSize(ctx, longText, 50, 30, "Tahoma");
			expect(result).toBeGreaterThanOrEqual(8);
		});

		it("handles empty text", () => {
			const ctx = createMockContext();
			const result = findBestFontSize(ctx, "", 100, 50, "Tahoma");
			// Empty text: no lines needed, so binary search should return max
			expect(result).toBeGreaterThanOrEqual(8);
		});

		it("returns smaller size for longer text", () => {
			const ctx = createMockContext();
			ctx.measureText.mockImplementation((t: string) => ({ width: t.length * 10 }));
			const short = findBestFontSize(ctx, "ab", 100, 50, "Tahoma");
			const long = findBestFontSize(ctx, "abcdefghijabcdefghij", 100, 50, "Tahoma");
			expect(short).toBeGreaterThan(long);
		});
	});
});
