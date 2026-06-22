import { describe, expect, it } from "vitest";
import {
	DEFAULT_READING_DIRECTION,
	defaultReadingDirectionForSourceLang,
	isReversedReadingStrip,
	isVerticalReading,
	normalizeReadingDirection,
	orderPageIndexesForReading,
	readingCssDirection,
	readingMoveControls,
	readingNavGlyphs,
	resolveArrowPageStep,
} from "$lib/project/reading-direction.js";

describe("reading direction defaults by source language", () => {
	it("defaults Japanese source to RTL (manga)", () => {
		expect(defaultReadingDirectionForSourceLang("ja")).toBe("rtl");
		expect(defaultReadingDirectionForSourceLang("JA")).toBe("rtl");
		expect(defaultReadingDirectionForSourceLang(" jp ")).toBe("rtl");
		expect(defaultReadingDirectionForSourceLang("japanese")).toBe("rtl");
	});

	it("defaults every other source (and empty) to LTR", () => {
		expect(defaultReadingDirectionForSourceLang("ko")).toBe("ltr");
		expect(defaultReadingDirectionForSourceLang("zh")).toBe("ltr");
		expect(defaultReadingDirectionForSourceLang("en")).toBe("ltr");
		expect(defaultReadingDirectionForSourceLang("")).toBe("ltr");
		expect(defaultReadingDirectionForSourceLang(null)).toBe(DEFAULT_READING_DIRECTION);
		expect(defaultReadingDirectionForSourceLang(undefined)).toBe(DEFAULT_READING_DIRECTION);
	});
});

describe("normalizeReadingDirection", () => {
	it("passes through valid values and falls back otherwise", () => {
		expect(normalizeReadingDirection("rtl")).toBe("rtl");
		expect(normalizeReadingDirection("ltr")).toBe("ltr");
		expect(normalizeReadingDirection("vertical")).toBe("vertical");
		expect(normalizeReadingDirection("sideways")).toBe(DEFAULT_READING_DIRECTION);
		expect(normalizeReadingDirection(undefined)).toBe(DEFAULT_READING_DIRECTION);
		expect(normalizeReadingDirection(42)).toBe(DEFAULT_READING_DIRECTION);
	});
});

describe("orderPageIndexesForReading (RTL page order, no off-by-one)", () => {
	it("reverses display order for RTL but keeps every index exactly once", () => {
		expect(orderPageIndexesForReading(5, "rtl")).toEqual([4, 3, 2, 1, 0]);
		// First reading page (index 0) sits last in the array -> rightmost in an rtl strip.
		expect(orderPageIndexesForReading(5, "rtl").at(-1)).toBe(0);
		expect(orderPageIndexesForReading(5, "rtl").at(0)).toBe(4);
	});

	it("keeps natural order for LTR and vertical", () => {
		expect(orderPageIndexesForReading(4, "ltr")).toEqual([0, 1, 2, 3]);
		expect(orderPageIndexesForReading(4, "vertical")).toEqual([0, 1, 2, 3]);
	});

	it("handles empty and single-page chapters without off-by-one", () => {
		expect(orderPageIndexesForReading(0, "rtl")).toEqual([]);
		expect(orderPageIndexesForReading(1, "rtl")).toEqual([0]);
		expect(orderPageIndexesForReading(-3, "rtl")).toEqual([]);
	});

	it("does not mutate any logical page index regardless of direction", () => {
		const count = 6;
		for (const dir of ["rtl", "ltr", "vertical"] as const) {
			const ordered = orderPageIndexesForReading(count, dir);
			expect([...ordered].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
		}
	});
});

describe("resolveArrowPageStep (keyboard nav per direction)", () => {
	it("flips physical arrows for RTL so Left advances forward in reading order", () => {
		expect(resolveArrowPageStep("left", "rtl")).toBe("next");
		expect(resolveArrowPageStep("right", "rtl")).toBe("prev");
	});

	it("keeps natural arrow mapping for LTR and vertical", () => {
		expect(resolveArrowPageStep("left", "ltr")).toBe("prev");
		expect(resolveArrowPageStep("right", "ltr")).toBe("next");
		expect(resolveArrowPageStep("left", "vertical")).toBe("prev");
		expect(resolveArrowPageStep("right", "vertical")).toBe("next");
	});
});

describe("reading mode helpers", () => {
	it("flags vertical as continuous scroll only", () => {
		expect(isVerticalReading("vertical")).toBe(true);
		expect(isVerticalReading("rtl")).toBe(false);
		expect(isVerticalReading("ltr")).toBe(false);
	});

	it("maps to a CSS direction value", () => {
		expect(readingCssDirection("rtl")).toBe("rtl");
		expect(readingCssDirection("ltr")).toBe("ltr");
		expect(readingCssDirection("vertical")).toBe("ltr");
	});
});

describe("reading strip glyph/move alignment (RTL visual reversal)", () => {
	it("flags only RTL as a visually reversed strip", () => {
		expect(isReversedReadingStrip("rtl")).toBe(true);
		expect(isReversedReadingStrip("ltr")).toBe(false);
		expect(isReversedReadingStrip("vertical")).toBe(false);
	});

	it("flips prev/next chevron glyphs for RTL so they point to their visual side", () => {
		const rtl = readingNavGlyphs("rtl");
		expect(rtl.prev).toBe("›");
		expect(rtl.next).toBe("‹");
		for (const dir of ["ltr", "vertical"] as const) {
			const glyphs = readingNavGlyphs(dir);
			expect(glyphs.prev).toBe("‹");
			expect(glyphs.next).toBe("›");
		}
	});

	it("flips per-row move glyph/label for RTL while keeping logical earlier/later semantics", () => {
		const rtl = readingMoveControls("rtl");
		expect(rtl.earlier).toEqual({ glyph: "v", word: "ลง" });
		expect(rtl.later).toEqual({ glyph: "^", word: "ขึ้น" });
		for (const dir of ["ltr", "vertical"] as const) {
			const controls = readingMoveControls(dir);
			expect(controls.earlier).toEqual({ glyph: "^", word: "ขึ้น" });
			expect(controls.later).toEqual({ glyph: "v", word: "ลง" });
		}
	});
});
