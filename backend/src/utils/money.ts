// Decimal-safe money helpers for the revenue layer (payment_transactions).
//
// Amounts are MINOR UNITS (cents) stored in a Postgres `bigint` column. Two hazards
// motivate keeping everything as integer strings / BigInt end-to-end rather than JS
// `number`:
//
//   1. SUM aggregates over many rows can exceed Number.MAX_SAFE_INTEGER (2^53-1 ≈
//      9.0e15 cents ≈ $90 trillion). Coercing a Postgres bigint/numeric SUM through
//      `Number()` would silently lose precision on a large total. We carry SUM
//      results as integer STRINGS instead (also JSON-serializable for the API).
//   2. A Dodo Dispute.amount is a MAJOR-unit decimal STRING ("19.99"), not minor
//      units. Converting with `Number(x) * 100` introduces float drift
//      (e.g. 19.99 * 100 === 1998.9999999999998). We parse the integer + fractional
//      parts as strings and assemble exact integer cents.

/** Largest absolute cents value still exactly representable as a JS number. */
const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

// ISO-4217 minor-unit map. Most currencies are 2-decimal; the exceptions below are
// the standard ISO-4217 zero-decimal and three-decimal sets. Centralized here so
// EVERY decimal-major→minor-unit conversion (payments, refunds, disputes — in both
// the live webhook path and the backfill) shares ONE source of truth and can't drift.
//
// Zero-decimal (the smallest denomination IS the major unit): JPY 1900 == ¥1900.
const ZERO_DECIMAL_CURRENCIES = new Set([
	"BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG",
	"RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);
// Three-decimal currencies (1 major unit == 1000 minor units): KWD 1.234 == 1234 fils.
const THREE_DECIMAL_CURRENCIES = new Set([
	"BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND",
]);

/**
 * ISO-4217 minor-unit count for a currency code (0 for JPY/KRW/…; 3 for KWD/BHD/…;
 * 2 by default and for unknown/empty input). Case-insensitive; tolerates null. This
 * is the SINGLE source of truth for how many minor digits a currency has — every
 * decimal→cents conversion routes its `minorDigits` through here.
 */
export function minorUnitsFor(currency: string | null | undefined): number {
	if (!currency) return 2;
	const code = currency.trim().toUpperCase();
	if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
	if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
	return 2;
}

/**
 * Normalize a cents value (minor units) from a number | bigint | string into an
 * INTEGER STRING suitable for binding to a `bigint` column. Fractional inputs are
 * rounded half-up (away from zero) to the nearest integer cent. Non-finite /
 * unparseable inputs collapse to "0".
 *
 * A JS NUMBER input must be a SAFE integer (Number.isSafeInteger) when whole —
 * otherwise the value already lost precision before reaching us (JSON parsed
 * 9007199254740993 as ...992), so we THROW rather than silently store a corrupted
 * cent value. Whole values within the safe range and genuinely-fractional values
 * (which round) are accepted. The string/BigInt path stays exact at any magnitude.
 *
 * Accepting a string lets the decimal-major→cents converter hand off an exact value
 * that never round-trips through a lossy JS number.
 */
export function normalizeCents(value: number | bigint | string | null | undefined): string {
	if (value === null || value === undefined) return "0";
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return "0";
		// Integer fast-path keeps exactness for the common minor-unit integers Dodo
		// emits — but a whole number beyond the safe-integer range has ALREADY been
		// corrupted by JS, so reject it (exact-or-rejected) instead of storing garbage.
		if (Number.isInteger(value)) {
			if (!Number.isSafeInteger(value)) {
				throw new RangeError(
					`money value ${value} exceeds Number.MAX_SAFE_INTEGER and was already truncated by JS — parse it from a string to preserve precision`,
				);
			}
			return BigInt(value).toString();
		}
		return roundHalfUpToString(value);
	}
	const trimmed = value.trim();
	if (!trimmed) return "0";
	// Already an integer string (the normal case for a normalized cents value).
	if (/^[+-]?\d+$/.test(trimmed)) return BigInt(trimmed).toString();
	// A decimal string of cents (rare) — round to the nearest integer cent.
	return decimalStringToInteger(trimmed);
}

/** Negate a cents value (number | bigint | string) and return an integer string. */
export function negateCents(value: number | bigint | string | null | undefined): string {
	const normalized = normalizeCents(value);
	if (normalized === "0") return "0";
	return normalized.startsWith("-") ? normalized.slice(1) : `-${normalized}`;
}

/** Absolute value of a cents value as an integer string. */
export function absCents(value: number | bigint | string | null | undefined): string {
	const normalized = normalizeCents(value);
	return normalized.startsWith("-") ? normalized.slice(1) : normalized;
}

/**
 * Convert a MAJOR-unit decimal string ("19.99", "-5", "0.005") to an exact integer
 * count of MINOR UNITS (cents) as a string. Parses the integer and fractional parts
 * as strings — never `Number(x) * 100` — so "19.99" → "1999" exactly. A fractional
 * tail beyond `minorDigits` is rounded half-up at the cent (e.g. "19.005" is 1900.5
 * cents → "1901"). Returns null for unparseable input.
 *
 * `minorDigits` is the number of minor-unit digits for the currency (2 for most;
 * 0 for zero-decimal currencies like JPY). Dodo's dispute amounts are decimal
 * strings sized to the currency, so a JPY "1900" dispute (0-decimal) stays 1900.
 * Callers derive it from `minorUnitsFor(currency)` so the conversion respects the
 * currency's real precision (JPY 0, KWD 3, USD 2) instead of assuming 2 everywhere.
 */
export function majorDecimalToCents(value: string | number, minorDigits = 2): string | null {
	let raw: string;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return null;
		// A whole number outside the safe range was already corrupted by JS before it
		// reached us (exact-or-rejected). A fractional number stringifies losslessly
		// for the magnitudes a major-unit amount realistically uses.
		if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
			throw new RangeError(
				`money value ${value} exceeds Number.MAX_SAFE_INTEGER and was already truncated by JS — parse it from a string to preserve precision`,
			);
		}
		raw = String(value);
	} else {
		raw = value.trim();
	}
	if (!raw) return null;
	const match = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(raw);
	if (!match) return null;
	const [, sign, intPartRaw, fracPartRaw = ""] = match;
	// Require at least one digit somewhere ("." / "" / "-" alone are unparseable).
	if (intPartRaw === "" && fracPartRaw === "") return null;
	const intPart = intPartRaw || "0";
	const negative = sign === "-";
	// Right-pad/truncate the fractional part to exactly `minorDigits`, rounding the
	// dropped tail half-up so e.g. "19.005" (2-digit currency) → 1900.5 → 1901 cents.
	const padded = (fracPartRaw + "0".repeat(minorDigits)).slice(0, minorDigits);
	const remainder = fracPartRaw.slice(minorDigits);
	let cents = BigInt(intPart) * BigInt(10) ** BigInt(minorDigits) + BigInt(padded || "0");
	if (remainder && /[5-9]/.test(remainder[0] ?? "")) {
		cents += BigInt(1); // round half-up on the first dropped digit
	}
	if (cents === BigInt(0)) return "0";
	return negative ? `-${cents.toString()}` : cents.toString();
}

/**
 * Read a MINOR-UNIT (cents) field from a webhook/backfill payload and return an
 * EXACT integer-cents string — never round-tripping through a JS `number`, which
 * would silently truncate a value larger than Number.MAX_SAFE_INTEGER (e.g. a
 * provider payload of `"9007199254740993"` → 9007199254740992). An integer string
 * is parsed with BigInt (exact at any magnitude); a fractional/number input is
 * normalized half-up. A whole NUMBER above the safe-integer range was already
 * corrupted by JS before reaching us, so `normalizeCents` THROWS on it (exact-or-
 * rejected) rather than persisting a wrong cent value — prefer the raw STRING field.
 * Returns null when no listed key is present or the value is not a finite number /
 * parseable numeric string.
 *
 * Pairs with the `amountCents: number | bigint | string` inputs on the transaction
 * stores, which bind the string straight to the `bigint` column with no coercion.
 */
export function readMinorUnitCents(source: Record<string, unknown>, keys: string[]): string | null {
	if (!source || typeof source !== "object" || Array.isArray(source)) return null;
	for (const key of keys) {
		const value = (source as Record<string, unknown>)[key];
		if (typeof value === "bigint") return value.toString();
		if (typeof value === "number") {
			if (!Number.isFinite(value)) continue;
			return normalizeCents(value);
		}
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (!trimmed) continue;
			// An integer string (the common minor-unit shape) is parsed exactly via
			// BigInt — no precision loss at any magnitude.
			if (/^[+-]?\d+$/.test(trimmed)) return BigInt(trimmed).toString();
			// A decimal cents string (rare) — round to the nearest integer cent exactly.
			if (/^[+-]?\d*\.\d+$/.test(trimmed)) return normalizeCents(trimmed);
			continue;
		}
	}
	return null;
}

/** Sum an array of cents values (any accepted form) into an exact integer string. */
export function sumCents(values: Array<number | bigint | string | null | undefined>): string {
	let total = BigInt(0);
	for (const value of values) {
		total += BigInt(normalizeCents(value));
	}
	return total.toString();
}

/**
 * Best-effort convert a cents string back to a JS number for callers that need one
 * (e.g. legacy per-row display). Throws if the value would lose precision so a bug
 * surfaces loudly rather than silently corrupting a total.
 */
export function centsStringToNumber(value: string): number {
	const big = BigInt(normalizeCents(value));
	if (big > MAX_SAFE_CENTS || big < -MAX_SAFE_CENTS) {
		throw new RangeError(`cents value ${value} exceeds Number.MAX_SAFE_INTEGER`);
	}
	return Number(big);
}

function roundHalfUpToString(value: number): string {
	// Round half-up away from zero, matching majorDecimalToCents.
	const rounded = value < 0 ? -Math.round(-value) : Math.round(value);
	return BigInt(rounded).toString();
}

function decimalStringToInteger(value: string): string {
	const match = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(value);
	if (!match) return "0";
	const [, sign, intPartRaw, fracPartRaw = ""] = match;
	const intPart = intPartRaw || "0";
	let result = BigInt(intPart);
	if (fracPartRaw && /[5-9]/.test(fracPartRaw[0] ?? "")) {
		result += BigInt(1);
	}
	if (result === BigInt(0)) return "0";
	return sign === "-" ? `-${result.toString()}` : result.toString();
}
