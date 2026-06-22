// Compact display label for a language code in the library/overview UI (cards,
// chips, breadcrumbs, chapter rows). The data model stores ISO-639-1 codes
// ("ja", "th", "id", "ms", "en", …); we uppercase them for display but alias a
// few to the conventions scanlation teams actually use — notably the Japanese
// source, which reads as "JP" (the raws) rather than the ISO "JA".
const DISPLAY_CODE_ALIASES: Record<string, string> = {
	ja: "JP",
};

/**
 * Format a language code for compact display. Returns "" for an empty/missing
 * code so callers can fall through to their own placeholder. Unknown codes are
 * simply uppercased (codes can be free-typed, e.g. "pt-BR" → "PT-BR").
 */
export function formatLangCode(code: string | null | undefined): string {
	const normalized = (code ?? "").trim();
	if (!normalized) return "";
	return DISPLAY_CODE_ALIASES[normalized.toLowerCase()] ?? normalized.toUpperCase();
}
