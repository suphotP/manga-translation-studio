import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	canUseSfxProvider,
	isSfxDisabled,
	listAvailableSfxProviders,
	resolveSfxPinnedProvider,
	resolveSfxProviderOrder,
	resolveSfxTierDispatchProviders,
} from "../services/provider-controls.js";
import {
	listAvailableOfficialProviderCandidates,
	resolveAiTierProviderRoute,
	resolveOfficialProviderCandidates,
} from "../services/provider-routing.js";
import type { AppConfig } from "../types/index.js";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
	return {
		openrouterEnabled: true,
		openrouterApiKey: "sk-test",
		openaiImagesEnabled: true,
		openaiImageModel: "gpt-image-1",
		openaiImageDefaultQuality: "low",
		chatgptEnabled: true,
		primaryBackend: "chatgpt",
		providerKillSwitches: {},
		sfxProviderMode: "auto",
		promptModerationEnabled: true,
		imageModerationEnabled: true,
		aiPythonEnabled: false,
		aiDefaultProvider: "openai",
		aiSupportEnabled: true,
		supportAgentProvider: "openai",
		supportAgentModel: "gpt-5.5",
		...overrides,
	};
}

// Several of the new SFX/official resolvers read process.env.OPENAI_API_KEY (the
// platform OpenAI image client reads its key there). Pin it for deterministic tests.
let previousOpenAiKey: string | undefined;
beforeEach(() => {
	previousOpenAiKey = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "sk-test";
});
afterEach(() => {
	if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = previousOpenAiKey;
});

describe("provider controls", () => {
	test("maps AI tiers to explicit provider routes", () => {
		expect(resolveAiTierProviderRoute("budget-clean")).toMatchObject({
			providerHint: "openai-gpt-image-2",
			adapter: "openai-image",
			model: "gpt-image-1",
			implemented: true,
		});
		expect(resolveAiTierProviderRoute("clean-pro")).toMatchObject({
			providerHint: "openai-gpt-image-2",
			adapter: "openai-image",
			model: "gpt-image-1",
			implemented: true,
		});
		expect(resolveAiTierProviderRoute("sfx-pro")).toMatchObject({
			providerHint: "openai-gpt-image-2",
			adapter: "openai-image",
			model: "gpt-image-1",
			implemented: true,
		});
	});

	test("auto mode prefers OpenAI image, then legacy fallbacks", () => {
		expect(resolveSfxProviderOrder(config())).toEqual([
			"openai-gpt-image-2",
			"python-worker",
			"openrouter-gpt-5.4-image-2",
		]);
	});

	test("kill switch removes the current worker path", () => {
		const previous = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "sk-test";
		const cfg = config({ providerKillSwitches: { "python-worker": true } });
		try {
			expect(canUseSfxProvider(cfg, "python-worker")).toBe(false);
			expect(listAvailableSfxProviders(cfg)).toEqual(["openai-gpt-image-2", "openrouter-gpt-5.4-image-2"]);
		} finally {
			if (previous === undefined) {
				delete process.env.OPENAI_API_KEY;
			} else {
				process.env.OPENAI_API_KEY = previous;
			}
		}
	});

	test("disabled mode exposes no SFX providers", () => {
		expect(listAvailableSfxProviders(config({ sfxProviderMode: "disabled" }))).toEqual([]);
	});
});

describe("official provider candidates (codex P1 #1 + #3)", () => {
	test("default (openai) lists OpenAI first, OpenRouter as failover", () => {
		const candidates = resolveOfficialProviderCandidates(config());
		expect(candidates.map((c) => c.officialId)).toEqual(["openai", "openrouter"]);
		expect(candidates.every((c) => c.available)).toBe(true);
	});

	test("AI_DEFAULT_PROVIDER=openrouter puts OpenRouter first", () => {
		const candidates = resolveOfficialProviderCandidates(config({ aiDefaultProvider: "openrouter" }));
		expect(candidates.map((c) => c.officialId)).toEqual(["openrouter", "openai"]);
	});

	test("OpenRouter-only platform (no OpenAI) still has an available candidate", () => {
		// No OpenAI key/enable, but OpenRouter configured + default → submit must be allowed.
		delete process.env.OPENAI_API_KEY;
		const cfg = config({ aiDefaultProvider: "openrouter", openaiImagesEnabled: false });
		const available = listAvailableOfficialProviderCandidates(cfg);
		expect(available).toHaveLength(1);
		expect(available[0]?.officialId).toBe("openrouter");
	});

	test("a killed default provider drops out; the other remains available", () => {
		const cfg = config({ providerKillSwitches: { "openai-gpt-image-2": true } });
		const available = listAvailableOfficialProviderCandidates(cfg);
		expect(available.map((c) => c.officialId)).toEqual(["openrouter"]);
	});

	test("nothing configured → no available candidate (submit blocked)", () => {
		delete process.env.OPENAI_API_KEY;
		const cfg = config({ openaiImagesEnabled: false, openrouterEnabled: false, openrouterApiKey: "" });
		expect(listAvailableOfficialProviderCandidates(cfg)).toHaveLength(0);
	});
});

describe("SFX tier gating mirrors the router (codex P1 #2)", () => {
	test("disabled mode blocks the sfx-pro tier", () => {
		const cfg = config({ sfxProviderMode: "disabled" });
		expect(isSfxDisabled(cfg)).toBe(true);
		expect(resolveSfxTierDispatchProviders(cfg)).toEqual([]);
	});

	test("default/auto mode defers to AI_DEFAULT_PROVIDER (OpenRouter wins when pinned)", () => {
		// The legacy default mode must NOT override aiDefaultProvider for sfx-pro.
		const cfg = config({ sfxProviderMode: "openai-gpt-image-2", aiDefaultProvider: "openrouter" });
		expect(resolveSfxPinnedProvider(cfg)).toBeNull();
		expect(resolveSfxTierDispatchProviders(cfg)[0]).toBe("openrouter-gpt-5.4-image-2");
	});

	test("an explicit OpenRouter pin restricts sfx-pro to OpenRouter only", () => {
		const cfg = config({ sfxProviderMode: "gpt-5.4-image-2" });
		expect(resolveSfxPinnedProvider(cfg)).toBe("openrouter-gpt-5.4-image-2");
		expect(resolveSfxTierDispatchProviders(cfg)).toEqual(["openrouter-gpt-5.4-image-2"]);
	});

	test("a python-worker pin yields nothing when AI_PYTHON_ENABLED is off (blocked)", () => {
		const cfg = config({ sfxProviderMode: "python-worker", aiPythonEnabled: false });
		expect(resolveSfxPinnedProvider(cfg)).toBe("python-worker");
		expect(resolveSfxTierDispatchProviders(cfg)).toEqual([]);
	});

	test("OpenRouter-only platform can still run sfx-pro (no OpenAI key)", () => {
		delete process.env.OPENAI_API_KEY;
		const cfg = config({ aiDefaultProvider: "openrouter", openaiImagesEnabled: false });
		expect(resolveSfxTierDispatchProviders(cfg)).toEqual(["openrouter-gpt-5.4-image-2"]);
	});
});
