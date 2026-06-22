import { beforeEach, describe, expect, it } from "vitest";
import {
	COOKIE_CONSENT_STORAGE_KEY,
	COOKIE_CONSENT_VERSION,
	DEFAULT_COOKIE_CONSENT,
	acceptAllConsent,
	loadConsent,
	parseStoredConsent,
	rejectNonEssentialConsent,
	saveConsent,
	serializeConsent,
	shouldPromptForConsent,
} from "$lib/consent/cookie-consent";

function createMemoryStorage() {
	const map = new Map<string, string>();
	return {
		getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
		raw: map,
	};
}

let storage: ReturnType<typeof createMemoryStorage>;

beforeEach(() => {
	storage = createMemoryStorage();
});

describe("cookie consent defaults", () => {
	it("opts analytics and marketing OUT by default, necessary always on", () => {
		expect(DEFAULT_COOKIE_CONSENT).toEqual({ necessary: true, analytics: false, marketing: false });
		expect(acceptAllConsent()).toEqual({ necessary: true, analytics: true, marketing: true });
		expect(rejectNonEssentialConsent()).toEqual({ necessary: true, analytics: false, marketing: false });
	});
});

describe("cookie consent persistence", () => {
	it("prompts when nothing is stored yet", () => {
		expect(shouldPromptForConsent(storage)).toBe(true);
		expect(loadConsent(storage)).toBeNull();
	});

	it("persists a choice and stops prompting", () => {
		const stored = saveConsent({ necessary: true, analytics: true, marketing: false }, storage);
		expect(stored.analytics).toBe(true);
		expect(stored.marketing).toBe(false);
		expect(stored.necessary).toBe(true);
		expect(stored.version).toBe(COOKIE_CONSENT_VERSION);
		expect(typeof stored.updatedAt).toBe("string");

		expect(shouldPromptForConsent(storage)).toBe(false);
		const loaded = loadConsent(storage);
		expect(loaded?.analytics).toBe(true);
		expect(loaded?.marketing).toBe(false);
	});

	it("round-trips reject-all without enabling optional categories", () => {
		saveConsent(rejectNonEssentialConsent(), storage);
		const loaded = loadConsent(storage);
		expect(loaded).not.toBeNull();
		expect(loaded?.analytics).toBe(false);
		expect(loaded?.marketing).toBe(false);
		expect(loaded?.necessary).toBe(true);
	});

	it("writes under the documented storage key", () => {
		saveConsent(acceptAllConsent(), storage);
		expect(storage.raw.has(COOKIE_CONSENT_STORAGE_KEY)).toBe(true);
	});

	it("re-prompts when stored schema version is stale", () => {
		storage.raw.set(
			COOKIE_CONSENT_STORAGE_KEY,
			JSON.stringify({ necessary: true, analytics: true, marketing: true, version: 0 }),
		);
		expect(loadConsent(storage)).toBeNull();
		expect(shouldPromptForConsent(storage)).toBe(true);
	});

	it("ignores corrupt stored values", () => {
		storage.raw.set(COOKIE_CONSENT_STORAGE_KEY, "not-json{");
		expect(loadConsent(storage)).toBeNull();
		expect(parseStoredConsent("not-json{")).toBeNull();
		expect(parseStoredConsent(null)).toBeNull();
	});

	it("never trusts a forged necessary=false flag", () => {
		const raw = serializeConsent({ necessary: false as unknown as true, analytics: false, marketing: false });
		const parsed = parseStoredConsent(raw);
		expect(parsed?.necessary).toBe(true);
	});

	it("stamps a deterministic timestamp when one is provided", () => {
		const now = new Date("2026-06-02T00:00:00.000Z");
		const stored = saveConsent(acceptAllConsent(), storage, now);
		expect(stored.updatedAt).toBe("2026-06-02T00:00:00.000Z");
	});
});
