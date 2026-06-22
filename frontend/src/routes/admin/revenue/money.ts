// Money formatting for the accountant revenue dashboard.
//
// CONTRACT (mirrors backend/src/routes/admin/revenue.ts): every amount arriving
// from the API is integer MINOR UNITS (cents) carried as a STRING — a sum can
// exceed Number.MAX_SAFE_INTEGER, so we NEVER coerce a cents value through
// Number() for the displayed figure. All exact formatting below is pure
// string/BigInt arithmetic and respects ISO-4217 minor-unit counts (JPY 0, USD 2,
// KWD 3). Figures are always PER CURRENCY — this module never sums across them.

// ISO-4217 minor-unit exceptions (mirrors the backend lookup). Anything not listed
// is the common 2-decimal case.
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
 * Exact decimal-major string from an integer-cents string, for the currency's
 * precision, using only string/BigInt math (no float). "1999"+2 → "1999.99" wait:
 * "199900"+2 → "1999.00"; "-1900"+0 (JPY) → "-1900". Group separators are added to
 * the integer part for readability ("1,234,567.89").
 */
export function centsToDecimalString(cents: string, minorDigits: number): string {
	const raw = (cents ?? "").trim() || "0";
	const negative = raw.startsWith("-");
	const digits = (negative ? raw.slice(1) : raw).replace(/^0+(?=\d)/, "");
	const sign = negative ? "-" : "";
	if (minorDigits <= 0) {
		return sign + groupThousands(digits || "0");
	}
	const padded = (digits || "0").padStart(minorDigits + 1, "0");
	const intPart = padded.slice(0, padded.length - minorDigits);
	const fracPart = padded.slice(padded.length - minorDigits);
	return `${sign}${groupThousands(intPart)}.${fracPart}`;
}

/** Insert ASCII thousands separators into a non-negative integer digit string. */
function groupThousands(intDigits: string): string {
	return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Display string for a per-currency money amount: exact decimal + currency code,
 * e.g. "$1,999.00 USD" / "¥120,000 JPY". Symbol is best-effort (falls back to the
 * code only). The currency code is ALWAYS shown so a figure is never ambiguous.
 */
const SYMBOLS: Record<string, string> = {
	USD: "$", EUR: "€", GBP: "£", JPY: "¥", THB: "฿", AUD: "A$", CAD: "C$", CNY: "¥", KRW: "₩", INR: "₹",
};

export function formatMoney(cents: string, currency: string | null | undefined): string {
	const code = (currency ?? "").trim().toUpperCase();
	const decimal = centsToDecimalString(cents, minorDigitsFor(code));
	const symbol = code ? (SYMBOLS[code] ?? "") : "";
	// Negative sign sits before the symbol: "-$19.99 USD".
	if (decimal.startsWith("-")) {
		return `-${symbol}${decimal.slice(1)}${code ? ` ${code}` : ""}`.trim();
	}
	return `${symbol}${decimal}${code ? ` ${code}` : ""}`.trim();
}

/**
 * Best-effort conversion of integer-cents to a major-unit JS number, for CHART
 * geometry / sparkline visuals ONLY (never for the displayed money figure). The
 * value is bounded to a chart, so float imprecision on a huge number is acceptable
 * here; the exact figure is always shown via {@link formatMoney}.
 */
export function centsToMajorNumber(cents: string, currency: string | null | undefined): number {
	const n = Number(cents);
	if (!Number.isFinite(n)) return 0;
	const divisor = 10 ** minorDigitsFor(currency);
	return n / divisor;
}
