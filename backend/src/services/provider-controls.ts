import type { AppConfig, ProviderId } from "../types/index.js";
import { listAvailableOfficialProviderCandidates } from "./provider-routing.js";

const SFX_OPENAI_PROVIDER: ProviderId = "openai-gpt-image-2";
const SFX_OPENROUTER_PROVIDER: ProviderId = "openrouter-gpt-5.4-image-2";
const SFX_WORKER_PROVIDER: ProviderId = "python-worker";

export function isProviderKilled(config: AppConfig, provider: ProviderId): boolean {
	return config.providerKillSwitches?.[provider] === true;
}

export function resolveSfxProviderOrder(config: AppConfig): ProviderId[] {
	if (config.sfxProviderMode === "disabled") return [];
	if (config.sfxProviderMode === "openai-gpt-image-2") return [SFX_OPENAI_PROVIDER];
	if (config.sfxProviderMode === "python-worker") return [SFX_WORKER_PROVIDER];
	if (config.sfxProviderMode === "gpt-5.4-image-2") return [SFX_OPENROUTER_PROVIDER];
	return [SFX_OPENAI_PROVIDER, SFX_WORKER_PROVIDER, SFX_OPENROUTER_PROVIDER];
}

export function canUseSfxProvider(config: AppConfig, provider: ProviderId): boolean {
	if (isProviderKilled(config, provider)) return false;
	if (provider === SFX_OPENAI_PROVIDER) return config.openaiImagesEnabled && Boolean(process.env.OPENAI_API_KEY);
	// W4.7: the reverse-engineered Python scraper worker is DORMANT unless the
	// operator explicitly opts in via AI_PYTHON_ENABLED (config.aiPythonEnabled,
	// default FALSE everywhere). With it off — i.e. in production — SFX jobs route
	// to the official-API providers only and never touch the legacy worker.
	if (provider === SFX_WORKER_PROVIDER) return config.aiPythonEnabled && config.chatgptEnabled;
	if (provider === SFX_OPENROUTER_PROVIDER) return config.openrouterEnabled && Boolean(config.openrouterApiKey);
	return false;
}

export function listAvailableSfxProviders(config: AppConfig): ProviderId[] {
	return resolveSfxProviderOrder(config).filter((provider) => canUseSfxProvider(config, provider));
}

/**
 * Whether the SFX controls BLOCK sfx-pro execution outright (sfxProviderMode is
 * `disabled`). When blocked, the router/submit-gate must not run the tier at all —
 * this is the hard gate the audit requires (`disabled` mode actually blocks).
 */
export function isSfxDisabled(config: AppConfig): boolean {
	return config.sfxProviderMode === "disabled";
}

/**
 * Does sfxProviderMode PIN sfx-pro to a single explicit provider (overriding the
 * official-default order)? Returns that ProviderId, or null for the modes that defer
 * to the official-default ordering (`auto` and the legacy `openai-gpt-image-2`
 * default — the latter historically meant "use the configured default provider",
 * which is why AI_DEFAULT_PROVIDER=openrouter must still win for sfx-pro).
 */
export function resolveSfxPinnedProvider(config: AppConfig): ProviderId | null {
	if (config.sfxProviderMode === "python-worker") return SFX_WORKER_PROVIDER;
	if (config.sfxProviderMode === "gpt-5.4-image-2") return SFX_OPENROUTER_PROVIDER;
	return null;
}

export const SFX_WORKER_PROVIDER_ID = SFX_WORKER_PROVIDER;

/**
 * Whether the sfx-pro tier can actually run under the current config — the SAME
 * gating the router applies (so the submit-gate and capabilities panel agree with
 * execution). `disabled` blocks; an explicit python-worker / OpenRouter pin restricts
 * to that provider; otherwise it defers to the official-default candidates (so
 * AI_DEFAULT_PROVIDER is honored for SFX). Returns the ProviderId order that would be
 * tried, empty when nothing can serve it.
 */
export function resolveSfxTierDispatchProviders(config: AppConfig): ProviderId[] {
	if (isSfxDisabled(config)) return [];
	const pin = resolveSfxPinnedProvider(config);
	if (pin === SFX_WORKER_PROVIDER) {
		return canUseSfxProvider(config, SFX_WORKER_PROVIDER) ? [SFX_WORKER_PROVIDER] : [];
	}
	let officials = listAvailableOfficialProviderCandidates(config).map((candidate) => candidate.providerId);
	if (pin === SFX_OPENROUTER_PROVIDER) {
		officials = officials.filter((providerId) => providerId === SFX_OPENROUTER_PROVIDER);
	}
	return officials;
}
