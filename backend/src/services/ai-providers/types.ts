// W4.7 — Official AI provider abstraction.
//
// This is the clean, default path for AI jobs. The two official providers
// (OpenAI, OpenRouter — per the locked product decision, those two only) each
// implement this interface. The reverse-engineered Python scraper worker is NOT
// a provider here: it is a dormant, dev/admin-only legacy path gated behind
// AI_PYTHON_ENABLED in the router.
//
// FORMAT LOCK: task type strictly selects the model family. An "image" task
// (crop/clean/SFX work that returns pixels) MUST route to an image-output model;
// a "text" task (translation/OCR text) MUST route to a text model. Adapters
// enforce this so a text model can never be handed an image task (and vice
// versa), regardless of caller input.

import type { AiOfficialProvider } from "../../types/index.js";
import type { OpenAiImageSize } from "../openai-image.js";

export type AiProviderTaskType = "image" | "text";

export type AiImageQualityLevel = "low" | "medium" | "high";

export interface AiProviderRequest {
	taskType: AiProviderTaskType;
	prompt: string;
	/** Required for image tasks. */
	imageBuffer?: Buffer;
	mimeType?: string;
	filename?: string;
	/** Optional explicit model id. When omitted the adapter picks the format-locked default. */
	model?: string;
	/** Image-task tuning. */
	quality?: AiImageQualityLevel;
	size?: OpenAiImageSize;
	/** Provider passthrough — abuse attribution (OpenAI `user`). */
	user?: string;
	/** Per-request API key (BYO). Falls back to the platform key when omitted. */
	apiKey?: string;
	/** Injectable fetch for tests. */
	fetchImpl?: typeof fetch;
}

export interface AiProviderResult {
	provider: AiOfficialProvider;
	model: string;
	taskType: AiProviderTaskType;
	/** Present for image tasks. */
	buffer?: Buffer;
	/** Present for text tasks. */
	text?: string;
	usage?: unknown;
	requestMs?: number;
}

export class AiProviderError extends Error {
	constructor(
		message: string,
		readonly code = "ai_provider_error",
		readonly retryable = false,
	) {
		super(message);
		this.name = "AiProviderError";
	}
}

export interface AiProvider {
	readonly id: AiOfficialProvider;
	/**
	 * Format-locked model list for a task type. The first entry is the default.
	 * Image task types only ever return image-output models; text task types
	 * only ever return text models.
	 */
	modelsForTask(taskType: AiProviderTaskType): string[];
	/** Run a request. Adapters enforce the format lock before dispatch. */
	run(request: AiProviderRequest): Promise<AiProviderResult>;
}
