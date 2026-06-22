// Locks the money-formatting contract for the accountant revenue dashboard: exact
// ISO-4217 minor-unit precision, string/BigInt math (no float drift on huge sums),
// and per-currency display (a code is always shown so a figure is never ambiguous).
import { describe, it, expect } from "vitest";
import { centsToDecimalString, formatMoney, minorDigitsFor, centsToMajorNumber } from "./money.ts";

describe("minorDigitsFor", () => {
	it("defaults to 2 decimals for common currencies and unknowns", () => {
		expect(minorDigitsFor("USD")).toBe(2);
		expect(minorDigitsFor("eur")).toBe(2);
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
		expect(minorDigitsFor("BHD")).toBe(3);
	});
});

describe("centsToDecimalString", () => {
	it("formats USD cents with 2 decimals + grouping", () => {
		expect(centsToDecimalString("199900", 2)).toBe("1,999.00");
		expect(centsToDecimalString("1999", 2)).toBe("19.99");
		expect(centsToDecimalString("5", 2)).toBe("0.05");
		expect(centsToDecimalString("0", 2)).toBe("0.00");
	});
	it("formats JPY (zero-decimal) with no decimal point", () => {
		expect(centsToDecimalString("120000", 0)).toBe("120,000");
		expect(centsToDecimalString("-1900", 0)).toBe("-1,900");
	});
	it("formats KWD (three-decimal)", () => {
		expect(centsToDecimalString("1234567", 3)).toBe("1,234.567");
	});
	it("preserves sign for refunds/disputes", () => {
		expect(centsToDecimalString("-2500", 2)).toBe("-25.00");
	});
	it("stays exact for values beyond Number.MAX_SAFE_INTEGER (BigInt path)", () => {
		// 90071992547409910 cents = 900,719,925,474,099.10 — exceeds MAX_SAFE_INTEGER
		// as an integer; float math would lose the trailing digits.
		expect(centsToDecimalString("90071992547409910", 2)).toBe("900,719,925,474,099.10");
	});
});

describe("formatMoney", () => {
	it("shows symbol + exact decimal + ISO code", () => {
		expect(formatMoney("199900", "USD")).toBe("$1,999.00 USD");
		expect(formatMoney("120000", "JPY")).toBe("¥120,000 JPY");
	});
	it("places the negative sign before the symbol", () => {
		expect(formatMoney("-2500", "USD")).toBe("-$25.00 USD");
	});
	it("falls back to code-only when no symbol is known but always shows the code", () => {
		expect(formatMoney("100000", "SEK")).toBe("1,000.00 SEK");
	});
	it("handles a missing currency (shows the figure, no code)", () => {
		expect(formatMoney("1000", null)).toBe("10.00");
	});
});

describe("centsToMajorNumber (chart geometry only)", () => {
	it("scales by the currency minor units", () => {
		expect(centsToMajorNumber("199900", "USD")).toBe(1999);
		expect(centsToMajorNumber("120000", "JPY")).toBe(120000);
		expect(centsToMajorNumber("1234567", "KWD")).toBe(1234.567);
	});
	it("returns 0 for non-numeric input", () => {
		expect(centsToMajorNumber("nope", "USD")).toBe(0);
	});
});
