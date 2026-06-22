import { describe, expect, it } from "vitest";
import {
	AI_IMAGE_QUALITIES,
	AI_QUALITY_OPTIONS,
	DEFAULT_AI_QUALITY,
	QUALITY_CREDIT_UNITS,
	isQualityAllowed,
	qualityCreditUnits,
	resolveUsableQuality,
} from "$lib/project/ai-quality.js";

describe("ai-quality cost mapping", () => {
	it("maps Low/Medium/High to 1/9/36 credits (matches backend QUALITY_CREDIT_UNITS)", () => {
		expect(QUALITY_CREDIT_UNITS.low).toBe(1);
		expect(QUALITY_CREDIT_UNITS.medium).toBe(9);
		expect(QUALITY_CREDIT_UNITS.high).toBe(36);
		expect(qualityCreditUnits("low")).toBe(1);
		expect(qualityCreditUnits("medium")).toBe(9);
		expect(qualityCreditUnits("high")).toBe(36);
	});

	it("exposes the three qualities in ascending cost order with matching option credits", () => {
		expect(AI_IMAGE_QUALITIES).toEqual(["low", "medium", "high"]);
		expect(AI_QUALITY_OPTIONS.map((o) => o.id)).toEqual(["low", "medium", "high"]);
		expect(AI_QUALITY_OPTIONS.map((o) => o.creditUnits)).toEqual([1, 9, 36]);
	});

	it("defaults to medium", () => {
		expect(DEFAULT_AI_QUALITY).toBe("medium");
	});
});

describe("ai-quality plan gating", () => {
	it("allows everything when the allowed list is missing or empty (no plan scope yet)", () => {
		expect(isQualityAllowed("high", undefined)).toBe(true);
		expect(isQualityAllowed("high", [])).toBe(true);
	});

	it("only permits qualities in the plan's allowed set", () => {
		expect(isQualityAllowed("low", ["low"])).toBe(true);
		expect(isQualityAllowed("medium", ["low"])).toBe(false);
		expect(isQualityAllowed("high", ["low"])).toBe(false);
		// Studio allows all three.
		expect(isQualityAllowed("high", ["low", "medium", "high"])).toBe(true);
	});
});

describe("resolveUsableQuality", () => {
	it("keeps the preferred quality when allowed", () => {
		expect(resolveUsableQuality("high", ["low", "medium", "high"])).toBe("high");
		expect(resolveUsableQuality("medium", undefined)).toBe("medium");
	});

	it("snaps to the default (medium) when the preferred quality is locked but the default is allowed", () => {
		expect(resolveUsableQuality("high", ["low", "medium"])).toBe("medium");
	});

	it("falls back to the highest allowed quality when neither preferred nor default is allowed", () => {
		// Free plan: only low allowed.
		expect(resolveUsableQuality("high", ["low"])).toBe("low");
		expect(resolveUsableQuality("medium", ["low"])).toBe("low");
	});
});
