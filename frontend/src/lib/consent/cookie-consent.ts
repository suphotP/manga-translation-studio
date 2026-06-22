// Granular cookie-consent model + persistence.
//
// Categories follow the GDPR/CCPA/PDPA convention: "necessary" cookies are
// always on (strictly required to run the app), while "analytics" and
// "marketing" are opt-in and default to OFF until the visitor decides.
//
// This module is intentionally framework-free so it can be unit-tested without
// a DOM and reused from the banner component and the footer "Cookie settings"
// re-open link.

export type CookieCategory = "necessary" | "analytics" | "marketing";

export interface CookieConsent {
	necessary: true;
	analytics: boolean;
	marketing: boolean;
}

export interface StoredCookieConsent extends CookieConsent {
	/** Schema version so we can re-prompt if the categories ever change. */
	version: number;
	/** ISO timestamp of when the choice was recorded (audit trail for GDPR). */
	updatedAt: string;
}

export const COOKIE_CONSENT_STORAGE_KEY = "comic-workspace.cookieConsent";
export const COOKIE_CONSENT_VERSION = 1;

/** Opt-in categories default to OFF. Necessary is always on. */
export const DEFAULT_COOKIE_CONSENT: CookieConsent = {
	necessary: true,
	analytics: false,
	marketing: false,
};

/** Everything the visitor can switch on. */
export function acceptAllConsent(): CookieConsent {
	return { necessary: true, analytics: true, marketing: true };
}

/** Only strictly-necessary cookies. */
export function rejectNonEssentialConsent(): CookieConsent {
	return { necessary: true, analytics: false, marketing: false };
}

function normalizeConsent(value: unknown): StoredCookieConsent | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (record.version !== COOKIE_CONSENT_VERSION) return null;
	return {
		necessary: true,
		analytics: record.analytics === true,
		marketing: record.marketing === true,
		version: COOKIE_CONSENT_VERSION,
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
	};
}

/** Parse a raw localStorage string into a stored consent, or null if invalid/stale. */
export function parseStoredConsent(raw: string | null): StoredCookieConsent | null {
	if (!raw) return null;
	try {
		return normalizeConsent(JSON.parse(raw));
	} catch {
		return null;
	}
}

/** Serialize a consent choice for persistence, stamping version + timestamp. */
export function serializeConsent(consent: CookieConsent, now = new Date()): string {
	const stored: StoredCookieConsent = {
		necessary: true,
		analytics: consent.analytics === true,
		marketing: consent.marketing === true,
		version: COOKIE_CONSENT_VERSION,
		updatedAt: now.toISOString(),
	};
	return JSON.stringify(stored);
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function resolveStorage(storage?: StorageLike): StorageLike | null {
	if (storage) return storage;
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

/** Read the persisted choice. Returns null when nothing valid is stored yet. */
export function loadConsent(storage?: StorageLike): StoredCookieConsent | null {
	const store = resolveStorage(storage);
	if (!store) return null;
	try {
		return parseStoredConsent(store.getItem(COOKIE_CONSENT_STORAGE_KEY));
	} catch {
		return null;
	}
}

/** Persist a choice. Returns the stored shape that was written. */
export function saveConsent(consent: CookieConsent, storage?: StorageLike, now = new Date()): StoredCookieConsent {
	const stored = parseStoredConsent(serializeConsent(consent, now))!;
	const store = resolveStorage(storage);
	if (store) {
		try {
			store.setItem(COOKIE_CONSENT_STORAGE_KEY, JSON.stringify(stored));
		} catch {
			/* storage unavailable (private mode / quota) — choice is still applied in-memory */
		}
	}
	return stored;
}

/** True when the visitor has not yet made a choice and the banner should show. */
export function shouldPromptForConsent(storage?: StorageLike): boolean {
	return loadConsent(storage) === null;
}
