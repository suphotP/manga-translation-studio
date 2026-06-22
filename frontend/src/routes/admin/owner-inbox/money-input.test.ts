// Owner-inbox MODIFY amount conversion — the float-free bridge between the
// owner's major-unit input and the backend's integer-minor-units contract.

import { describe, it, expect } from "vitest";
import { minorDigitsFor, centsToMajorInput, majorInputToCents } from "./money-input.ts";

describe("minorDigitsFor", () => {
	it("defaults to 2 for the common case + unknown/empty currency", () => {
		expect(minorDigitsFor("USD")).toBe(2);
		expect(minorDigitsFor("thb")).toBe(2);
		expect(minorDigitsFor("ZZZ")).toBe(2);
		expect(minorDigitsFor(null)).toBe(2);
		expect(minorDigitsFor(undefined)).toBe(2);
	});
	it("knows zero-decimal currencies (JPY, KRW)", () => {
		expect(minorDigitsFor("JPY")).toBe(0);
		expect(minorDigitsFor("krw")).toBe(0);
	});
	it("knows three-decimal currencies (KWD, BHD)", () => {
		expect(minorDigitsFor("KWD")).toBe(3);
		expect(minorDigitsFor("bhd")).toBe(3);
	});
});

describe("centsToMajorInput (cents → editable major string)", () => {
	it("formats 2-decimal currencies", () => {
		expect(centsToMajorInput(1999, "USD")).toBe("19.99");
		expect(centsToMajorInput(0, "USD")).toBe("0.00");
		expect(centsToMajorInput(5, "USD")).toBe("0.05");
		expect(centsToMajorInput(100, "USD")).toBe("1.00");
	});
	it("formats zero-decimal currencies as whole numbers", () => {
		expect(centsToMajorInput(1000, "JPY")).toBe("1000");
		expect(centsToMajorInput(0, "JPY")).toBe("0");
	});
	it("formats three-decimal currencies", () => {
		expect(centsToMajorInput(1234567, "KWD")).toBe("1234.567");
		expect(centsToMajorInput(5, "KWD")).toBe("0.005");
	});
	it("clamps negatives/NaN to zero", () => {
		expect(centsToMajorInput(-500, "USD")).toBe("0.00");
		expect(centsToMajorInput(Number.NaN, "USD")).toBe("0.00");
	});
});

describe("majorInputToCents (major string → integer cents)", () => {
	it("round-trips a 2-decimal figure to exact cents", () => {
		expect(majorInputToCents("19.99", "USD")).toBe(1999);
		expect(majorInputToCents("1.00", "USD")).toBe(100);
		expect(majorInputToCents("0.05", "USD")).toBe(5);
		expect(majorInputToCents("1000", "USD")).toBe(100000);
	});
	it("accepts a whole number with fewer fraction digits than precision", () => {
		expect(majorInputToCents("19.9", "USD")).toBe(1990);
		expect(majorInputToCents("19", "USD")).toBe(1900);
	});
	it("handles zero-decimal currencies (no fraction allowed)", () => {
		expect(majorInputToCents("1000", "JPY")).toBe(1000);
		expect(majorInputToCents("1000.5", "JPY")).toBeNull();
	});
	it("handles three-decimal currencies", () => {
		expect(majorInputToCents("1234.567", "KWD")).toBe(1234567);
		expect(majorInputToCents("0.005", "KWD")).toBe(5);
	});
	it("rejects over-precision, negatives, empty, and non-numeric input", () => {
		expect(majorInputToCents("19.999", "USD")).toBeNull(); // too many decimals for USD
		expect(majorInputToCents("-5.00", "USD")).toBeNull();
		expect(majorInputToCents("", "USD")).toBeNull();
		expect(majorInputToCents("  ", "USD")).toBeNull();
		expect(majorInputToCents("abc", "USD")).toBeNull();
		expect(majorInputToCents("1.2.3", "USD")).toBeNull();
		expect(majorInputToCents("$19.99", "USD")).toBeNull();
	});
	it("is the inverse of centsToMajorInput for valid amounts", () => {
		for (const [cents, cur] of [[1999, "USD"], [1000, "JPY"], [1234567, "KWD"], [5, "USD"]] as const) {
			expect(majorInputToCents(centsToMajorInput(cents, cur), cur)).toBe(cents);
		}
	});
});
