import type { AiCostEstimate, AiImageQuality, AiTier, ProviderId } from "../types/index.js";
import { resolveAiTierProviderRoute } from "./provider-routing.js";

export const AI_COST_PRICING_VERSION = "openai-gpt-image-2-2026-05-28-official-input-output-prices";
const THB_PER_USD = 36;
const GPT_IMAGE_2_IMAGE_INPUT_USD_PER_1M_TOKENS = 8;
const GPT_IMAGE_2_TEXT_INPUT_USD_PER_1M_TOKENS = 5;
const ESTIMATED_IMAGE_INPUT_TOKENS_PER_MEGAPIXEL = 1250;
const GPT_IMAGE_HIGH_FIDELITY_BASE_TOKENS = 65;
const GPT_IMAGE_HIGH_FIDELITY_TILE_TOKENS = 129;
const GPT_IMAGE_HIGH_FIDELITY_SQUARE_EXTRA_TOKENS = 4160;
const GPT_IMAGE_HIGH_FIDELITY_ORIENTED_EXTRA_TOKENS = 6240;
const MIN_TEXT_INPUT_TOKENS = 500;
const OPENAI_IMAGE_ORIENTATION_THRESHOLD = 1.2;
export type OpenAiImageOutputSize = "1024x1024" | "1536x1024" | "1024x1536";

const GPT_IMAGE_2_STANDARD_OUTPUT_PRICES_USD: Record<OpenAiImageOutputSize, Record<AiImageQuality, number>> = {
	"1024x1024": {
		low: 0.006,
		medium: 0.053,
		high: 0.211,
	},
	"1536x1024": {
		low: 0.005,
		medium: 0.041,
		high: 0.165,
	},
	"1024x1536": {
		low: 0.005,
		medium: 0.041,
		high: 0.165,
	},
};

// ×10 credit rebase (2026-06-12, owner decision): one LOW image charges 10
// credits instead of 1 so plan numbers read generously and finer-grained ops
// can price below a full low-image later. Still cost-proportional (1:9:36).
// THB_PER_CREDIT in plans.ts shrank 10× in the same change, and migration 0087
// multiplies all stored grant/ledger/allocation amounts by 10 — the THB value
// of every existing balance is unchanged. These three places move TOGETHER.
const QUALITY_CREDIT_UNITS: Record<AiImageQuality, number> = {
	low: 10,
	medium: 90,
	high: 360,
};

const TIER_ESTIMATES: Record<AiTier, {
	providerHint: ProviderId;
	quality: AiImageQuality;
}> = {
	"budget-clean": {
		providerHint: resolveAiTierProviderRoute("budget-clean").providerHint,
		quality: "low",
	},
	"clean-pro": {
		providerHint: resolveAiTierProviderRoute("clean-pro").providerHint,
		quality: "medium",
	},
	"sfx-pro": {
		providerHint: resolveAiTierProviderRoute("sfx-pro").providerHint,
		quality: "low",
	},
};

function roundMoney(value: number): number {
	return Math.ceil(value * 100) / 100;
}

function roundUsd(value: number): number {
	return Math.ceil(value * 1_000_000) / 1_000_000;
}

function estimateTextInputTokens(prompt: string | undefined): number {
	if (!prompt?.trim()) return MIN_TEXT_INPUT_TOKENS;
	return Math.max(MIN_TEXT_INPUT_TOKENS, Math.ceil(prompt.length / 4));
}

function calculateTokenUsd(tokens: number, usdPerMillion: number): number {
	return roundUsd((tokens / 1_000_000) * usdPerMillion);
}

function estimateOpenAiImageOutputUsd(size: OpenAiImageOutputSize, quality: AiImageQuality): number {
	return GPT_IMAGE_2_STANDARD_OUTPUT_PRICES_USD[size][quality];
}

function estimateHighFidelityImageInputTokens(crop: { w: number; h: number }): number {
	const width = Math.max(1, crop.w);
	const height = Math.max(1, crop.h);
	const shortestSide = Math.min(width, height);
	const scale = 512 / shortestSide;
	const scaledW = width * scale;
	const scaledH = height * scale;
	const tileCount = Math.max(1, Math.ceil(scaledW / 512) * Math.ceil(scaledH / 512));
	const aspect = Math.max(width, height) / Math.min(width, height);
	const highFidelityExtra = aspect <= 1.2
		? GPT_IMAGE_HIGH_FIDELITY_SQUARE_EXTRA_TOKENS
		: GPT_IMAGE_HIGH_FIDELITY_ORIENTED_EXTRA_TOKENS;
	const highFidelityTokens = GPT_IMAGE_HIGH_FIDELITY_BASE_TOKENS
		+ tileCount * GPT_IMAGE_HIGH_FIDELITY_TILE_TOKENS
		+ highFidelityExtra;
	const megapixels = Math.max(0.01, (width * height) / 1_000_000);
	const megapixelFloor = Math.ceil(megapixels * ESTIMATED_IMAGE_INPUT_TOKENS_PER_MEGAPIXEL);
	return Math.max(megapixelFloor, highFidelityTokens);
}

export function estimateAiJobCost(input: {
	tier: AiTier;
	crop: { w: number; h: number };
	quality?: AiImageQuality;
	prompt?: string;
}): AiCostEstimate {
	const tier = input.tier;
	const estimate = TIER_ESTIMATES[tier] ?? TIER_ESTIMATES["sfx-pro"];
	const quality = resolveAiJobQuality(tier, input.quality);
	const outputSize = resolveOpenAiImageOutputSize(input.crop);
	const estimatedOutputUsd = estimateOpenAiImageOutputUsd(outputSize, quality);
	const creditUnits = QUALITY_CREDIT_UNITS[quality];
	const megapixels = Math.max(0.01, (input.crop.w * input.crop.h) / 1_000_000);
	const imageInputTokens = estimateHighFidelityImageInputTokens(input.crop);
	const textInputTokens = estimateTextInputTokens(input.prompt);
	const estimatedImageInputUsd = calculateTokenUsd(imageInputTokens, GPT_IMAGE_2_IMAGE_INPUT_USD_PER_1M_TOKENS);
	const estimatedTextInputUsd = calculateTokenUsd(textInputTokens, GPT_IMAGE_2_TEXT_INPUT_USD_PER_1M_TOKENS);
	const estimatedUsd = roundUsd(estimatedOutputUsd + estimatedImageInputUsd + estimatedTextInputUsd);
	const estimatedThb = roundMoney(estimatedUsd * THB_PER_USD);
	const reserveThb = roundMoney(estimatedThb * 1.25);

	return {
		tier,
		providerHint: estimate.providerHint,
		currency: "THB",
		quality,
		outputSize,
		creditUnits,
		megapixels: Math.round(megapixels * 1000) / 1000,
		imageInputTokens,
		textInputTokens,
		estimatedImageInputUsd,
		estimatedTextInputUsd,
		estimatedOutputUsd,
		estimatedUsd,
		estimatedThb,
		reserveThb,
		pricingVersion: AI_COST_PRICING_VERSION,
	};
}

export function resolveAiJobQuality(tier: AiTier, quality?: AiImageQuality): AiImageQuality {
	return quality ?? (TIER_ESTIMATES[tier] ?? TIER_ESTIMATES["sfx-pro"]).quality;
}

export function resolveOpenAiImageOutputSize(crop: { w: number; h: number }): OpenAiImageOutputSize {
	const width = Math.max(1, crop.w);
	const height = Math.max(1, crop.h);
	const aspect = width / height;
	if (aspect >= OPENAI_IMAGE_ORIENTATION_THRESHOLD) return "1536x1024";
	if (aspect <= 1 / OPENAI_IMAGE_ORIENTATION_THRESHOLD) return "1024x1536";
	return "1024x1024";
}
