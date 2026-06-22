// Reading direction support (W3.19)
// Per-chapter setting stored in project state JSON (no DB migration needed).
//   rtl      → manga (Japanese): pages read right-to-left, navigator strip reversed.
//   ltr      → manhua / western: pages read left-to-right (default for non-JP source).
//   vertical → webtoon / manhwa: continuous vertical scroll stack.

export type ReadingDirection = "rtl" | "ltr" | "vertical";

export const READING_DIRECTIONS: readonly ReadingDirection[] = ["rtl", "ltr", "vertical"];

export const DEFAULT_READING_DIRECTION: ReadingDirection = "ltr";

// Source languages whose comics are conventionally read right-to-left.
const RTL_SOURCE_LANGS = new Set(["ja", "jp", "japanese"]);

export interface ReadingDirectionOption {
	value: ReadingDirection;
	label: string;
	helper: string;
	icon: string;
}

export const READING_DIRECTION_OPTIONS: readonly ReadingDirectionOption[] = [
	{
		value: "rtl",
		label: "ขวาไปซ้าย (มังงะ)",
		helper: "อ่านขวาไปซ้าย หน้าเรียงกลับด้าน เหมาะกับมังงะญี่ปุ่น",
		icon: "←",
	},
	{
		value: "ltr",
		label: "ซ้ายไปขวา (มันฮวา)",
		helper: "อ่านซ้ายไปขวาตามปกติ เหมาะกับมันฮวาและการ์ตูนฝั่งตะวันตก",
		icon: "→",
	},
	// NOTE: the "vertical" (webtoon) continuous-strip option was removed from the
	// picker — the editor renders one page at a time for every direction. The
	// `vertical` value is kept in the type + normalizer for back-compat so any
	// existing project saved as vertical still loads (it just renders paged).
];

/** Narrow an unknown value to a valid ReadingDirection, falling back to the default. */
export function normalizeReadingDirection(value: unknown): ReadingDirection {
	return value === "rtl" || value === "ltr" || value === "vertical"
		? value
		: DEFAULT_READING_DIRECTION;
}

/**
 * Default reading direction by source language.
 * Japanese source → RTL (manga); everything else → LTR.
 */
export function defaultReadingDirectionForSourceLang(sourceLang: string | null | undefined): ReadingDirection {
	const lang = (sourceLang ?? "").trim().toLowerCase();
	return RTL_SOURCE_LANGS.has(lang) ? "rtl" : "ltr";
}

/**
 * Visual order of page indexes for the navigator/preview strip.
 * Page array order (logical page 1..N) is never mutated — only the *display* order
 * is reversed for RTL so page 1 sits on the right. LTR/vertical keep natural order.
 */
export function orderPageIndexesForReading(
	pageCount: number,
	direction: ReadingDirection,
): number[] {
	const indexes = Array.from({ length: Math.max(0, pageCount) }, (_, index) => index);
	return direction === "rtl" ? indexes.reverse() : indexes;
}

/**
 * Map a physical arrow-key intent ("left"/"right") to a logical page step ("prev"/"next")
 * for the given reading direction. For RTL, pressing the Left arrow advances forward in
 * reading order (next page); Right goes back. LTR/vertical keep the natural mapping.
 * Non-spatial keys (PageUp/PageDown, brackets, A/D) stay logical and bypass this.
 */
export function resolveArrowPageStep(
	arrow: "left" | "right",
	direction: ReadingDirection,
): "prev" | "next" {
	if (direction === "rtl") {
		return arrow === "left" ? "next" : "prev";
	}
	return arrow === "left" ? "prev" : "next";
}

/** True when pages should render as a single continuous vertical scroll stack. */
export function isVerticalReading(direction: ReadingDirection): boolean {
	return direction === "vertical";
}

/** CSS `direction` value to apply to the navigator strip so flex/inline order matches reading. */
export function readingCssDirection(direction: ReadingDirection): "rtl" | "ltr" {
	return direction === "rtl" ? "rtl" : "ltr";
}

/**
 * True when the navigator/preview strip is visually reversed (RTL). In that mode the
 * prev/next chevrons and per-row move controls must flip glyph/label so they stay aligned
 * with the side they actually act on. LTR/vertical keep the natural mapping.
 */
export function isReversedReadingStrip(direction: ReadingDirection): boolean {
	return direction === "rtl";
}

export interface ReadingNavGlyphs {
	/** Glyph for the logical previous-page control. */
	prev: string;
	/** Glyph for the logical next-page control. */
	next: string;
}

/** Chevron glyphs for the logical prev/next nav, flipped to match a reversed (RTL) strip. */
export function readingNavGlyphs(direction: ReadingDirection): ReadingNavGlyphs {
	return isReversedReadingStrip(direction)
		? { prev: "›", next: "‹" } // › / ‹
		: { prev: "‹", next: "›" }; // ‹ / ›
}

export interface ReadingMoveControl {
	/** Arrow glyph shown on the button. */
	glyph: string;
	/** Thai word used in aria-label/title. */
	word: string;
}

export interface ReadingMoveControls {
	/** Control that moves a page earlier in logical order (movePage direction -1). */
	earlier: ReadingMoveControl;
	/** Control that moves a page later in logical order (movePage direction +1). */
	later: ReadingMoveControl;
}

/**
 * Per-row "move page" control glyphs/labels. The logical action is unchanged (earlier = -1,
 * later = +1); only the visual glyph and label flip for a reversed (RTL) strip so the button
 * matches the direction the row appears to move in the reversed list.
 */
export function readingMoveControls(direction: ReadingDirection): ReadingMoveControls {
	return isReversedReadingStrip(direction)
		? { earlier: { glyph: "v", word: "ลง" }, later: { glyph: "^", word: "ขึ้น" } }
		: { earlier: { glyph: "^", word: "ขึ้น" }, later: { glyph: "v", word: "ลง" } };
}
