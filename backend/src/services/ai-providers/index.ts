// W4.7 — Official AI provider router (OpenAI / OpenRouter).
//
// This is the DEFAULT AI dispatch path for the platform. The reverse-engineered
// Python scraper worker (callPythonWorker in ai-router.ts) is a dormant,
// dev/admin-only legacy path gated behind config.aiPythonEnabled (env
// AI_PYTHON_ENABLED, default FALSE in every environment). When that flag is off
// — i.e. in production — AI jobs only ever reach the official providers below.
//
// ── SLA PATH ──────────────────────────────────────────────────────────────
// Official APIs (OpenAI / OpenRouter) come with vendor uptime/latency SLAs and
// supported, rate-limited, billable endpoints. The Python scraper drove a
// reverse-engineered consumer endpoint with NO SLA, NO support, and breakage /
// ToS risk. Hiding it behind aiPythonEnabled means the production SLA path is:
//
//   1. Primary  → config.aiDefaultProvider (OpenAI by default).
//   2. Failover → the OTHER official provider, attempted by ai-router.ts on a
//                 RETRYABLE primary failure (429/5xx/network). The ordered candidate
//                 list comes from resolveOfficialProviderCandidates (provider-routing.ts):
//                 the configured default first, the other configured+non-killed
//                 official provider second. A deterministic failure (format-lock, bad
//                 request) surfaces immediately rather than re-billing a second call.
//   3. BYO      → the workspace's own OpenAI/OpenRouter key (byo-api.ts), which
//                 keeps the same official-API SLA on the customer's account.
//
// The Python path is NEVER part of the production SLA chain. It exists only so a
// developer can A/B the legacy behavior locally by opting into AI_PYTHON_ENABLED.
//
// MODERATION: this router does not bypass moderation. The prompt-moderation gate
// runs in ai-router.ts before any provider dispatch, BYO image jobs run a
// mandatory CSAM check (byo-api.ts), and AI output is re-moderated on store.
// Adapters here are pure provider transport and must stay behind those gates.

import type { AiOfficialProvider, AppConfig } from "../../types/index.js";
import { openAiProvider } from "./openai.js";
import { openRouterProvider } from "./openrouter.js";
import type { AiProvider, AiProviderTaskType } from "./types.js";

export * from "./types.js";
export { openAiProvider, OpenAiProvider } from "./openai.js";
export { openRouterProvider, OpenRouterProvider } from "./openrouter.js";
export { OPENAI_IMAGE_MODELS, DEFAULT_OPENAI_IMAGE_MODEL, isSupportedOpenAiImageModel } from "./openai-models.js";

const PROVIDERS: Record<AiOfficialProvider, AiProvider> = {
	openai: openAiProvider,
	openrouter: openRouterProvider,
};

export const OFFICIAL_PROVIDER_IDS: readonly AiOfficialProvider[] = ["openai", "openrouter"];

/** Get a specific official provider adapter. */
export function getOfficialProvider(id: AiOfficialProvider): AiProvider {
	return PROVIDERS[id];
}

/**
 * Resolve the configured default official provider. OpenAI unless the operator
 * pinned OpenRouter via AI_DEFAULT_PROVIDER. This is the head of the SLA chain;
 * the Python worker is intentionally never returned here.
 */
export function resolveOfficialProvider(config: Pick<AppConfig, "aiDefaultProvider">): AiProvider {
	return PROVIDERS[config.aiDefaultProvider] ?? PROVIDERS.openai;
}

/**
 * Format-locked model selection. Returns the default model for the given
 * provider + task type. Image tasks always resolve to an image-output model and
 * text tasks always to a text model — the adapters reject any mismatch.
 */
export function resolveProviderModel(provider: AiProvider, taskType: AiProviderTaskType): string {
	return provider.modelsForTask(taskType)[0]!;
}
