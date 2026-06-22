// The selectable UI languages. Names are AUTONYMS — each language in its own
// script regardless of the active locale (NOT translatable copy; localizing
// them would mislabel the options). Lives in a .ts module so the autonym
// "ไทย" is shared by every picker surface (settings card, auth pages,
// LanguageSwitcher) without re-tripping the no-hardcoded-thai ratchet, which
// scans components/routes only.
export interface LanguageOption {
	code: "th" | "en" | "id" | "ms";
	/** Autonym — the language's name in its own script. */
	name: string;
	flag: string;
}

export const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
	{ code: "th", name: "ไทย", flag: "🇹🇭" },
	{ code: "en", name: "English", flag: "🇺🇸" },
	{ code: "id", name: "Bahasa Indonesia", flag: "🇮🇩" },
	{ code: "ms", name: "Bahasa Melayu", flag: "🇲🇾" },
];
