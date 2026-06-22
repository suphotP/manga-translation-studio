// Store-independent locale lookup for error boundaries.
//
// SvelteKit `+error.svelte` boundaries can render when app init is degraded, so
// they must NOT depend on the svelte-i18n store being initialised. This helper
// reads the persisted locale straight from localStorage and resolves dotted
// message keys against the bundled JSON dictionaries directly — no store, no
// async init. Falls back to the default locale (th) then to en, and finally to
// a caller-supplied default so an error screen always renders real copy.

import th from "$lib/i18n/locales/th.json";
import en from "$lib/i18n/locales/en.json";
import id from "$lib/i18n/locales/id.json";
import ms from "$lib/i18n/locales/ms.json";

type Dict = Record<string, unknown>;

const dictionaries: Record<string, Dict> = { th, en, id, ms };
const DEFAULT_LOCALE = "th";

function resolveLocale(): string {
	if (typeof window === "undefined") return DEFAULT_LOCALE;
	try {
		const stored = window.localStorage.getItem("manga-editor-locale");
		if (stored && stored in dictionaries) return stored;
	} catch {
		// localStorage can throw in privacy mode — fall through to detection.
	}
	// No explicit choice persisted yet (first-ever load): follow the browser's
	// preferred language, mirroring i18n/index.ts getInitialLocale()/detectBrowserLocale.
	// Without this, safeFormat/safeT (the API error formatter + error boundaries, which
	// read localStorage directly, not the svelte-i18n store) would always render Thai for
	// a first-time visitor while the app itself is in their browser language. Kept in sync
	// with index.ts by hand: this module is intentionally store-independent so error
	// boundaries can render without svelte-i18n being initialised.
	return detectBrowserLocale();
}

function detectBrowserLocale(): string {
	if (typeof navigator === "undefined") return DEFAULT_LOCALE;
	const candidates =
		Array.isArray(navigator.languages) && navigator.languages.length > 0
			? navigator.languages
			: navigator.language
				? [navigator.language]
				: [];
	for (const tag of candidates) {
		const primary = tag?.toLowerCase().split("-")[0];
		if (primary && primary in dictionaries) return primary;
	}
	return "en";
}

function lookup(dict: Dict | undefined, key: string): string | undefined {
	if (!dict) return undefined;
	let node: unknown = dict;
	for (const part of key.split(".")) {
		if (node && typeof node === "object" && part in (node as Dict)) {
			node = (node as Dict)[part];
		} else {
			return undefined;
		}
	}
	return typeof node === "string" ? node : undefined;
}

/**
 * Resolve a dotted i18n key for the persisted locale without the svelte-i18n
 * store. Falls back through the active locale → en → the provided default.
 */
export function safeT(key: string, fallback: string): string {
	const locale = resolveLocale();
	return lookup(dictionaries[locale], key) ?? lookup(dictionaries.en, key) ?? fallback;
}

/**
 * Like {@link safeT} but with `{token}` interpolation, resolved against the
 * persisted locale without the svelte-i18n store. Used by the API error
 * formatter (which throws synchronously at the network layer, before any
 * component formatter is available) so coded backend errors render in the
 * user's active language. Unknown tokens are left untouched.
 */
export function safeFormat(
	key: string,
	values: Record<string, string | number> = {},
	fallback = "",
): string {
	const locale = resolveLocale();
	const template = lookup(dictionaries[locale], key) ?? lookup(dictionaries.en, key) ?? fallback;
	if (!template) return fallback;
	return template.replace(/\{([^}]+)\}/g, (whole, name: string) => {
		const value = values[name.trim()];
		return value === undefined ? whole : String(value);
	});
}

/** The persisted active locale code (or the default when none is stored). */
export function activeLocale(): string {
	return resolveLocale();
}
