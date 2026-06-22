import type { AiOfficialProvider, AiTier, AppConfig, ProviderId } from "../types/index.js";
import { DEFAULT_OPENAI_IMAGE_MODEL } from "./ai-providers/openai-models.js";

export interface AiTierProviderRoute {
	tier: AiTier;
	providerHint: ProviderId;
	adapter: "openai-image" | "openrouter-image" | "sfx";
	model?: string;
	implemented: boolean;
	label: string;
	/**
	 * SFX-controlled tier: its provider candidates + fallback order come from the SFX
	 * controls (sfxProviderMode / per-provider kill switch / `disabled` blocks), not
	 * the generic official-default order. The actual image generation still runs
	 * through the official adapter pipeline (or the dormant legacy worker), so the
	 * adapter stays `openai-image`; this flag tells the router/submit-gate to gate the
	 * tier on the SFX controls instead.
	 */
	sfxControlled?: boolean;
}

const ROUTES: Record<AiTier, AiTierProviderRoute> = {
	"budget-clean": {
		tier: "budget-clean",
		providerHint: "openai-gpt-image-2",
		adapter: "openai-image",
		model: DEFAULT_OPENAI_IMAGE_MODEL,
		implemented: true,
		label: "Budget Clean",
	},
	"clean-pro": {
		tier: "clean-pro",
		providerHint: "openai-gpt-image-2",
		adapter: "openai-image",
		model: DEFAULT_OPENAI_IMAGE_MODEL,
		implemented: true,
		label: "Clean Pro",
	},
	"sfx-pro": {
		tier: "sfx-pro",
		providerHint: "openai-gpt-image-2",
		adapter: "openai-image",
		model: DEFAULT_OPENAI_IMAGE_MODEL,
		implemented: true,
		label: "SFX Pro",
		sfxControlled: true,
	},
};

export function resolveAiTierProviderRoute(tier: AiTier): AiTierProviderRoute {
	return ROUTES[tier] ?? ROUTES["sfx-pro"];
}

// Stable ProviderId used for kill-switch / job-event reporting per official
// provider. Mirrors resolveOfficialProviderReporting in ai-router.ts so submit-time
// availability and process-time dispatch agree on which kill switch gates a tier.
const OFFICIAL_PROVIDER_REPORTING_ID: Record<AiOfficialProvider, ProviderId> = {
	openai: "openai-gpt-image-2",
	openrouter: "openrouter-gpt-5.4-image-2",
};

export function officialProviderReportingId(officialId: AiOfficialProvider): ProviderId {
	return OFFICIAL_PROVIDER_REPORTING_ID[officialId];
}

export interface OfficialProviderCandidate {
	/** Official provider abstraction id (openai / openrouter). */
	officialId: AiOfficialProvider;
	/** ProviderId for kill-switch + job-event reporting. */
	providerId: ProviderId;
	/** Whether this candidate can serve the tier right now (config + kill switch). */
	available: boolean;
	/** Machine reason when unavailable (for diagnostics / submit-gate errors). */
	reason?: "provider_disabled" | "openai_images_not_configured" | "openrouter_not_configured";
}

type OfficialRoutingConfig = Pick<
	AppConfig,
	| "aiDefaultProvider"
	| "openaiImagesEnabled"
	| "openrouterEnabled"
	| "openrouterApiKey"
	| "providerKillSwitches"
>;

function evaluateOfficialProvider(config: OfficialRoutingConfig, officialId: AiOfficialProvider): OfficialProviderCandidate {
	const providerId = officialProviderReportingId(officialId);
	// Inlined kill-switch check (avoids a provider-controls import edge that perturbs
	// module init order during config load).
	if (config.providerKillSwitches?.[providerId] === true) {
		return { officialId, providerId, available: false, reason: "provider_disabled" };
	}
	if (officialId === "openai") {
		// The platform OpenAI key lives in process.env (the image client reads it
		// there); openaiImagesEnabled is the operator toggle.
		if (!config.openaiImagesEnabled || !process.env.OPENAI_API_KEY) {
			return { officialId, providerId, available: false, reason: "openai_images_not_configured" };
		}
		return { officialId, providerId, available: true };
	}
	if (!config.openrouterEnabled || !config.openrouterApiKey) {
		return { officialId, providerId, available: false, reason: "openrouter_not_configured" };
	}
	return { officialId, providerId, available: true };
}

/**
 * Ordered official-provider candidates for an official-API tier route. The operator's
 * configured default (aiDefaultProvider) comes first, the OTHER official provider
 * second — so both the submit-time availability gate and the process-time dispatch
 * loop agree on the SAME resolution and the same failover order. Each entry reports
 * whether it can serve the tier right now (config + kill switch).
 *
 * Used by:
 *   - ai-job-submission.providerUnavailable: allow the submit when ANY candidate can
 *     serve the tier (not just OpenAI) — fixes OpenRouter-default rejection at submit.
 *   - ai-router: try candidates in order, falling back on a retryable failure.
 */
export function resolveOfficialProviderCandidates(config: OfficialRoutingConfig): OfficialProviderCandidate[] {
	const primary = config.aiDefaultProvider === "openrouter" ? "openrouter" : "openai";
	const secondary: AiOfficialProvider = primary === "openai" ? "openrouter" : "openai";
	return [evaluateOfficialProvider(config, primary), evaluateOfficialProvider(config, secondary)];
}

export function listAvailableOfficialProviderCandidates(config: OfficialRoutingConfig): OfficialProviderCandidate[] {
	return resolveOfficialProviderCandidates(config).filter((candidate) => candidate.available);
}
