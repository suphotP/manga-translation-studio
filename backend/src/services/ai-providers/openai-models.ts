// Single source of truth for the OpenAI image-output model allow-list.
//
// Kept in a dependency-free module (no config/runtime imports) so BOTH the
// provider adapter (openai.ts, which imports config.ts) and config.ts itself can
// import it without a circular dependency. config.ts validates the configured
// OPENAI_IMAGE_MODEL against this set at load time (fail-fast on a bogus model),
// and the adapter's format lock rejects any model not in it before any network
// call.
//
// `gpt-image-1` is OpenAI's real image-generation/edit model id (the model the
// /v1/images/edits endpoint accepts). It MUST be present so a correct
// `.env` (OPENAI_IMAGE_MODEL=gpt-image-1) passes validation.

export const OPENAI_IMAGE_MODELS = ["gpt-image-1"] as const;

export const DEFAULT_OPENAI_IMAGE_MODEL = OPENAI_IMAGE_MODELS[0];

/** True when `model` is an accepted OpenAI image-output model id. */
export function isSupportedOpenAiImageModel(model: string): boolean {
	return (OPENAI_IMAGE_MODELS as readonly string[]).includes(model);
}
