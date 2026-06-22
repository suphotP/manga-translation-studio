import { addMessages, init, locale } from "svelte-i18n";
import { derived } from "svelte/store";
import th from "$lib/i18n/locales/th.json";
import en from "$lib/i18n/locales/en.json";
import id from "$lib/i18n/locales/id.json";
import ms from "$lib/i18n/locales/ms.json";

const localeDictionaries = {
	th,
	en,
	id,
	ms,
};

export type SupportedLocale = keyof typeof localeDictionaries;
export const LOCALE_STORAGE_KEY = "manga-editor-locale";

// Per-locale document metadata. `lang` is the BCP-47 tag stamped on
// <html lang>; `dir` drives <html dir> so RTL scripts (Arabic) lay out
// correctly. Only the document direction + CSS logical properties change —
// the editor's canvas/imageBounds coordinate math is unaffected.
type LocaleDirection = "ltr" | "rtl";
interface LocaleMeta {
	lang: string;
	dir: LocaleDirection;
}

const localeMeta: Record<SupportedLocale, LocaleMeta> = {
	th: { lang: "th", dir: "ltr" },
	en: { lang: "en", dir: "ltr" },
	id: { lang: "id", dir: "ltr" },
	ms: { lang: "ms", dir: "ltr" },
};

for (const [code, messages] of Object.entries(localeDictionaries)) {
	addMessages(code, messages);
}

const DEFAULT_LOCALE: SupportedLocale = "th";

export function isSupportedLocale(value: string | null | undefined): value is SupportedLocale {
	return Boolean(value && value in localeDictionaries);
}

export function normalizeLocale(value: string | null): SupportedLocale {
	if (isSupportedLocale(value)) return value;
	return DEFAULT_LOCALE;
}

type LocaleSyncHandler = (locale: SupportedLocale) => void | Promise<void>;
let localeSyncHandler: LocaleSyncHandler | null = null;

export function setLocaleSyncHandler(handler: LocaleSyncHandler | null): void {
	localeSyncHandler = handler;
}

// Reflect the active locale onto the live document: <html lang> + <html dir>.
// Called on init and on every setLocale() so the page direction follows the
// language (RTL for Arabic, LTR otherwise). No-op during SSR / non-browser.
function applyDocumentLocale(code: SupportedLocale): void {
	if (typeof document === "undefined") return;
	const meta = localeMeta[code] ?? localeMeta[DEFAULT_LOCALE];
	const root = document.documentElement;
	root.setAttribute("lang", meta.lang);
	root.setAttribute("dir", meta.dir);
}

/** The text direction ("ltr" | "rtl") for a locale; defaults to ltr. */
export function localeDirection(code: string | null | undefined): LocaleDirection {
	const normalized = normalizeLocale(code ?? null);
	return localeMeta[normalized]?.dir ?? "ltr";
}

// Map a BCP-47 / navigator.language tag (e.g. "ja", "ja-JP", "zh-Hans-CN")
// to one of the supported locales, or null if unsupported.
function matchSupportedLocale(tag: string | null | undefined): SupportedLocale | null {
	if (!tag) return null;
	const primary = tag.toLowerCase().split("-")[0];
	if (primary in localeDictionaries) return primary as SupportedLocale;
	return null;
}

// First-load default: pick from the browser's preferred languages among the
// supported locales, falling back to EN if none match.
function detectBrowserLocale(): SupportedLocale {
	if (typeof navigator === "undefined") return DEFAULT_LOCALE;
	const candidates: string[] =
		Array.isArray(navigator.languages) && navigator.languages.length > 0
			? [...navigator.languages]
			: navigator.language
				? [navigator.language]
				: [];
	for (const tag of candidates) {
		const match = matchSupportedLocale(tag);
		if (match) return match;
	}
	return "en";
}

function getInitialLocale(): SupportedLocale {
	if (typeof window === "undefined") return DEFAULT_LOCALE;

	const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
	// Respect an explicit, valid stored choice.
	if (stored && stored in localeDictionaries) return stored as SupportedLocale;
	// First load (or invalid stored value): follow the browser language.
	return detectBrowserLocale();
}

const INITIAL_LOCALE = getInitialLocale();

init({
	fallbackLocale: DEFAULT_LOCALE,
	initialLocale: INITIAL_LOCALE,
});

// Stamp <html lang>/<html dir> for the initial locale so RTL is correct on the
// very first paint (the static app.html ships lang="en" with no dir).
applyDocumentLocale(INITIAL_LOCALE);

export { locale };

/**
 * The localized chapter-label prefix word ("ตอน" / "Chapter" / "話数" …) for the
 * active locale, as a reactive store. Lets pure-util callers
 * (`buildWorkspaceProjectBrowser`, `getWorkspaceProjectChapterDisplayLabel`)
 * receive the locale prefix from ANY component — including ones that don't wire
 * up the full `$_` formatter — so chapter labels localize on the dashboard,
 * sidebar, library, and story-detail surfaces. Defaults to the Thai prefix so
 * stored Thai-prefixed data still parses and TH stays unchanged.
 */
export const chapterLabelPrefix = derived(locale, ($locale) => {
	const code = normalizeLocale($locale ?? null);
	const value = localeDictionaries[code]?.dashboard?.chapterFallback;
	return (typeof value === "string" && value.trim()) || "ตอน";
});

/**
 * The active document text direction as a reactive store ("ltr" | "rtl"),
 * derived from the current locale. Components can subscribe to flip
 * direction-aware UI without re-reading the DOM.
 */
export const direction = derived(locale, ($locale) => localeDirection($locale ?? null));

interface SetLocaleOptions {
	/** Skip the signed-in user preference write when applying a server preference. */
	syncUser?: boolean;
}

export function setLocale(newLocale: string, options: SetLocaleOptions = {}) {
	const nextLocale = normalizeLocale(newLocale);
	if (typeof window !== "undefined") {
		localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
	}
	locale.set(nextLocale);
	applyDocumentLocale(nextLocale);
	if (options.syncUser !== false && localeSyncHandler) {
		try {
			const result = localeSyncHandler(nextLocale);
			if (result && typeof result.then === "function") {
				// Keep local language switching usable offline; the auth store owns
				// retry/pending sync when this best-effort server write fails.
				void result.catch(() => undefined);
			}
		} catch {
			// The UI locale is already applied locally; profile sync must not undo it.
		}
	}
	return Promise.resolve(localeDictionaries[nextLocale]);
}

export { _ } from "svelte-i18n";
