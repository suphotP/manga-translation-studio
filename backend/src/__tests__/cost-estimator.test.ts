import { describe, expect, test } from "bun:test";
import { estimateAiJobCost, resolveOpenAiImageOutputSize } from "../services/cost-estimator.js";

describe("AI cost estimator", () => {
	test("estimates budget, pro, and SFX tiers with reserves", () => {
		const budget = estimateAiJobCost({ tier: "budget-clean", crop: { w: 1024, h: 1024 } });
		const cleanPro = estimateAiJobCost({ tier: "clean-pro", crop: { w: 1024, h: 1024 } });
		const sfxPro = estimateAiJobCost({ tier: "sfx-pro", crop: { w: 1024, h: 1024 } });

		expect(budget.providerHint).toBe("openai-gpt-image-2");
		expect(cleanPro.providerHint).toBe("openai-gpt-image-2");
		expect(sfxPro.providerHint).toBe("openai-gpt-image-2");
		expect(budget.quality).toBe("low");
		expect(cleanPro.quality).toBe("medium");
		expect(sfxPro.quality).toBe("low");
		expect(budget.outputSize).toBe("1024x1024");
		expect(cleanPro.estimatedOutputUsd).toBe(0.053);
		expect(cleanPro.estimatedUsd).toBeGreaterThan(cleanPro.estimatedOutputUsd!);
		expect(cleanPro.imageInputTokens).toBeGreaterThan(4000);
		expect(cleanPro.creditUnits).toBe(90);
		expect(budget.estimatedThb).toBeGreaterThan(0);
		expect(cleanPro.estimatedThb).toBeGreaterThan(budget.estimatedThb);
		expect(sfxPro.estimatedThb).toBe(budget.estimatedThb);
		expect(sfxPro.reserveThb).toBeGreaterThan(sfxPro.estimatedThb);
		expect(sfxPro.pricingVersion).toBe("openai-gpt-image-2-2026-05-28-official-input-output-prices");
	});

	test("tracks megapixels, output size, and image quality credit units", () => {
		const low = estimateAiJobCost({ tier: "clean-pro", crop: { w: 512, h: 512 }, quality: "low", prompt: "short prompt" });
		const high = estimateAiJobCost({ tier: "clean-pro", crop: { w: 3000, h: 3000 }, quality: "high" });
		const landscape = estimateAiJobCost({ tier: "sfx-pro", crop: { w: 1024, h: 512 }, quality: "low" });

		expect(low.creditUnits).toBe(10);
		expect(high.creditUnits).toBe(360);
		expect(high.estimatedThb).toBeGreaterThan(low.estimatedThb);
		expect(high.megapixels).toBe(9);
		expect(high.estimatedImageInputUsd).toBeGreaterThan(low.estimatedImageInputUsd!);
		expect(low.textInputTokens).toBe(500);
		expect(landscape.outputSize).toBe("1536x1024");
		expect(landscape.estimatedOutputUsd).toBe(0.005);
		expect(resolveOpenAiImageOutputSize({ w: 512, h: 1024 })).toBe("1024x1536");
	});

	test("maps crop aspect ratios to supported GPT image 2 output sizes", () => {
		expect(resolveOpenAiImageOutputSize({ w: 900, h: 300 })).toBe("1536x1024");
		expect(resolveOpenAiImageOutputSize({ w: 300, h: 900 })).toBe("1024x1536");
		expect(resolveOpenAiImageOutputSize({ w: 1120, h: 1024 })).toBe("1024x1024");
		expect(resolveOpenAiImageOutputSize({ w: 4000, h: 100 })).toBe("1536x1024");
	});
});
