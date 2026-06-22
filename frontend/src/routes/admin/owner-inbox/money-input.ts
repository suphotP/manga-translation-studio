// Owner-inbox MODIFY amount conversion — major-unit input ↔ integer minor units.
//
// The owner edits the sanctioned amount in a FAMILIAR major-unit figure (e.g.
// "19.99"), but the backend's owner-modify endpoint takes integer MINOR UNITS
// (cents) and rejects anything that is not a positive integer in range. This module
// is the exact, float-free bridge, respecting ISO-4217 minor-unit counts (JPY 0,
// USD 2, KWD 3) consistent with the revenue money.ts display path. Extracted from
// +page.svelte so the load-bearing arithmetic is unit-testable.

// ISO-4217 minor-unit exceptions (mirrors revenue/money.ts). Anything not listed is
// the common 2-decimal case.
const ZERO_DECIMAL = new Set([
	"BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

/** ISO-4217 minor-unit digit count for a currency code (defaults to 2). */
export function minorDigitsFor(currency: string | null | undefined): number {
	if (!currency) return 2;
	const code = currency.trim().toUpperCase();
	if (ZERO_DECIMAL.has(code)) return 0;
	if (THREE_DECIMAL.has(code)) return 3;
	return 2;
}

/**
 * Integer minor units → a major-unit STRING suitable for the modify <input>
 * (no thousands grouping, fixed minor-digit precision). 1999 USD → "19.99";
 * 1000 JPY → "1000"; 1234567 KWD → "1234.567".
 */
export function centsToMajorInput(cents: number, currency: string | null | undefined): string {
	const digits = minorDigitsFor(currency);
	const n = Math.max(0, Math.trunc(Number.isFinite(cents) ? cents : 0));
	if (digits <= 0) return String(n);
	const s = String(n).padStart(digits + 1, "0");
	const intPart = s.slice(0, s.length - digits);
	const frac = s.slice(s.length - digits);
	return `${intPart}.${frac}`;
}

/**
 * Major-unit input STRING → integer minor units for the currency. Float-free
 * (parses digit groups directly). Returns null when the input is not a clean money
 * figure for the currency (rejects empty / NaN / negatives / over-precision / non-
 * numeric), so the caller can keep the submit disabled.
 */
export function majorInputToCents(value: string, currency: string | null | undefined): number | null {
	const raw = (value ?? "").trim();
	if (!raw) return null;
	const digits = minorDigitsFor(currency);
	// Whole number for zero-decimal currencies; up to `digits` fraction places else.
	const re = digits > 0 ? new RegExp(`^\\d+(\\.\\d{1,${digits}})?$`) : /^\d+$/;
	if (!re.test(raw)) return null;
	const [intPart, fracPart = ""] = raw.split(".");
	const fracPadded = (fracPart + "0".repeat(digits)).slice(0, digits);
	const cents = Number(intPart) * 10 ** digits + (digits > 0 ? Number(fracPadded) : 0);
	return Number.isFinite(cents) ? Math.trunc(cents) : null;
}
