import { describe, expect, it } from "vitest";
import { detectTextScriptMismatch } from "$lib/project/text-script-qc.js";

describe("detectTextScriptMismatch", () => {
	it("does not flag matching Latin target text", () => {
		const result = detectTextScriptMismatch("Translated dialogue is ready.", "en");

		expect(result.mismatch).toBe(false);
		expect(result.targetScripts).toEqual(["latin"]);
	});

	it("flags CJK text left in an English target layer", () => {
		const result = detectTextScriptMismatch("まだ翻訳されていない台詞", "en");

		expect(result.mismatch).toBe(true);
		expect(result.nonTargetLetters).toBeGreaterThanOrEqual(5);
	});

	it("flags Latin text left in a Thai target layer without warning on tiny SFX words", () => {
		expect(detectTextScriptMismatch("HELLO THERE", "th").mismatch).toBe(true);
		expect(detectTextScriptMismatch("BANG", "th").mismatch).toBe(false);
	});

	it("accepts Japanese target text that mixes kana and kanji", () => {
		const result = detectTextScriptMismatch("これは翻訳済みです", "ja");

		expect(result.mismatch).toBe(false);
		expect(result.targetScripts).toEqual(["kana", "cjk"]);
	});
});
