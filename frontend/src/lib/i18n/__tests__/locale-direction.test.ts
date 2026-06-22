// Guards the direction plumbing: the active locale must drive <html lang>/<html
// dir>. All four shipped locales (th/en/id/ms) are LTR today, but the dir
// mechanism stays — a future RTL locale only needs its localeMeta entry, and
// these tests pin that unknown/dropped locales fall back to ltr instead of
// leaving a stale dir on the document.

import { beforeEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";

import { setLocale, localeDirection, direction } from "../index.ts";

describe("i18n document direction", () => {
	beforeEach(() => {
		document.documentElement.setAttribute("lang", "en");
		document.documentElement.setAttribute("dir", "ltr");
	});

	it("maps each supported locale to a direction", () => {
		expect(localeDirection("en")).toBe("ltr");
		expect(localeDirection("th")).toBe("ltr");
		expect(localeDirection("id")).toBe("ltr");
		expect(localeDirection("ms")).toBe("ltr");
	});

	it("falls back to ltr for unknown or no-longer-shipped locales", () => {
		expect(localeDirection("xx")).toBe("ltr");
		// Dropped locales (ja/ko/zh/ar) normalize to the default and stay ltr.
		expect(localeDirection("ar")).toBe("ltr");
		expect(localeDirection("ja")).toBe("ltr");
		expect(localeDirection(null)).toBe("ltr");
		expect(localeDirection(undefined)).toBe("ltr");
	});

	it("setLocale stamps <html lang> for the chosen locale and keeps dir=ltr", async () => {
		await setLocale("id");
		expect(document.documentElement.getAttribute("lang")).toBe("id");
		expect(document.documentElement.getAttribute("dir")).toBe("ltr");
		expect(get(direction)).toBe("ltr");
		await setLocale("en");
		expect(document.documentElement.getAttribute("lang")).toBe("en");
		expect(get(direction)).toBe("ltr");
	});
});
