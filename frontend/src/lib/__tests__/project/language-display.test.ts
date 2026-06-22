import { describe, expect, it } from "vitest";
import { formatLangCode } from "$lib/project/language-display.ts";

describe("formatLangCode", () => {
	it("aliases the Japanese source to JP (the scanlation 'raws' convention)", () => {
		expect(formatLangCode("ja")).toBe("JP");
		expect(formatLangCode("JA")).toBe("JP");
		expect(formatLangCode(" ja ")).toBe("JP");
	});

	it("uppercases other ISO codes unchanged", () => {
		expect(formatLangCode("th")).toBe("TH");
		expect(formatLangCode("id")).toBe("ID");
		expect(formatLangCode("ms")).toBe("MS");
		expect(formatLangCode("en")).toBe("EN");
		expect(formatLangCode("pt-BR")).toBe("PT-BR");
	});

	it("returns an empty string for a missing code so callers can fall through", () => {
		expect(formatLangCode(null)).toBe("");
		expect(formatLangCode(undefined)).toBe("");
		expect(formatLangCode("  ")).toBe("");
	});
});
