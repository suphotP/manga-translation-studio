// Tests for prompt builder — critical for AI image quality

import { describe, test, expect } from "bun:test";
import { buildCleanPrompt, buildPrompt } from "../prompt/builder.js";

describe("buildPrompt", () => {
	const baseOpts = {
		lang: "Thai",
	};

	test("Case 3: no text layers, no custom prompt — returns full translation prompt", () => {
		const prompt = buildPrompt({ ...baseOpts });
		expect(prompt).toContain("Translate ALL text");
		expect(prompt).toContain("Thai");
		expect(prompt).toContain("##Edit image from the original image##");
		expect(prompt).toContain("SFX");
	});

	test("Case 1: with text layers — includes reference translations", () => {
		const prompt = buildPrompt({
			...baseOpts,
			textLayers: ["สวัสดี", "คุณเป็นอย่างไร"],
		});
		expect(prompt).toContain("Reference translations");
		expect(prompt).toContain("สวัสดี");
		expect(prompt).toContain("คุณเป็นอย่างไร");
		expect(prompt).toContain("Read the original text");
		expect(prompt).toContain("##Edit image from the original image##");
	});

	test("Case 1: with text layers and SFX disabled — no SFX instruction", () => {
		const prompt = buildPrompt({
			...baseOpts,
			textLayers: ["test"],
			translateSfx: false,
		});
		expect(prompt).toContain("Reference translations");
		expect(prompt).not.toContain("Also search for and translate ALL SFX");
		expect(prompt).toContain("##Edit image from the original image##");
	});

	test("Case 2: with custom prompt — includes user's custom text", () => {
		const prompt = buildPrompt({
			...baseOpts,
			customPrompt: "Focus on the top-right panel",
		});
		expect(prompt).toContain("Focus on the top-right panel");
		expect(prompt).toContain("professional manhwa translator");
		expect(prompt).toContain("##Edit image from the original image##");
	});

	test("always contains the forbidden suffix", () => {
		const cases = [
			buildPrompt({ ...baseOpts }),
			buildPrompt({ ...baseOpts, textLayers: ["a"] }),
			buildPrompt({ ...baseOpts, customPrompt: "test" }),
		];
		for (const prompt of cases) {
			expect(prompt).toContain("##Edit image from the original image##");
		}
	});

	test("never contains forbidden words that trigger DALL-E mode", () => {
		const forbidden = ["generate", "create", "output image", "render image"];
		const prompt = buildPrompt({ ...baseOpts });
		for (const word of forbidden) {
			expect(prompt.toLowerCase()).not.toContain(word.toLowerCase());
		}
	});

	test("handles empty text layers array same as no text layers", () => {
		const prompt = buildPrompt({ ...baseOpts, textLayers: [] });
		expect(prompt).toContain("TASK: Translate ALL text");
		expect(prompt).not.toContain("Reference translations");
	});

	test("respects translateSfx=true for case 3", () => {
		const prompt = buildPrompt({ ...baseOpts, translateSfx: true });
		expect(prompt).toContain("SFX");
	});

	test("different lang parameter is used in prompt", () => {
		const prompt = buildPrompt({ lang: "English" });
		expect(prompt).toContain("English");
	});

	test("text layers with special characters are included", () => {
		const prompt = buildPrompt({
			...baseOpts,
			textLayers: ["Korean text: 콰광! Japanese: ドカン!"],
		});
		expect(prompt).toContain("콰광");
		expect(prompt).toContain("ドカン");
	});

	test("multiple text layers each get their own bullet point", () => {
		const prompt = buildPrompt({
			...baseOpts,
			textLayers: ["first", "second", "third"],
		});
		expect(prompt).toContain("- first");
		expect(prompt).toContain("- second");
		expect(prompt).toContain("- third");
	});
});

describe("buildCleanPrompt", () => {
	test("returns cleanup instructions without translation or typesetting", () => {
		const prompt = buildCleanPrompt({ customPrompt: "Keep screentone texture" });
		expect(prompt).toContain("Remove text");
		expect(prompt).toContain("Keep screentone texture");
		expect(prompt).toContain("Do not translate");
		expect(prompt).toContain("Do not translate, typeset");
		expect(prompt).toContain("##Edit image from the original image##");
	});
});
