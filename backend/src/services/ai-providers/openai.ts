// W4.7 — OpenAI official provider adapter.
//
// Image tasks reuse editImageWithOpenAi (the hardened image-edit client with
// retry/error taxonomy + result-size guards). Text tasks use the OpenAI
// Responses API. The format lock is enforced here: an image task can only run
// against an image-output model, a text task only against a text model.

import { serverConfig } from "../../config.js";
import { editImageWithOpenAi } from "../openai-image.js";
import { OPENAI_IMAGE_MODELS } from "./openai-models.js";
import {
	AiProviderError,
	type AiProvider,
	type AiProviderRequest,
	type AiProviderResult,
	type AiProviderTaskType,
} from "./types.js";

// Format-locked model families. Image-output models render pixels; text models
// return text only. Keep the first entry as the default for each task type.
//
// OPENAI_IMAGE_MODELS lives in ./openai-models.js (dependency-free) so config.ts
// can validate the configured OPENAI_IMAGE_MODEL against the SAME allow-list this
// adapter's format lock enforces — without a circular import. `gpt-image-1` is
// OpenAI's real image-edit model id; keeping it in that set is what lets a
// correct `.env` pass instead of dying with "not an OpenAI image model".
const OPENAI_TEXT_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"] as const;

const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

export class OpenAiProvider implements AiProvider {
	readonly id = "openai" as const;

	modelsForTask(taskType: AiProviderTaskType): string[] {
		return taskType === "image" ? [...OPENAI_IMAGE_MODELS] : [...OPENAI_TEXT_MODELS];
	}

	async run(request: AiProviderRequest): Promise<AiProviderResult> {
		const allowed = this.modelsForTask(request.taskType);
		const model = request.model || allowed[0]!;
		// FORMAT LOCK: reject a model that does not belong to this task type so a
		// text model can never service an image task (or vice versa).
		if (!allowed.includes(model)) {
			throw new AiProviderError(
				`Model '${model}' is not an OpenAI ${request.taskType} model`,
				"ai_provider_format_lock",
				false,
			);
		}

		if (request.taskType === "image") {
			if (!request.imageBuffer) {
				throw new AiProviderError("imageBuffer is required for image tasks", "ai_provider_image_required", false);
			}
			const result = await editImageWithOpenAi({
				imageBuffer: request.imageBuffer,
				prompt: request.prompt,
				apiKey: request.apiKey,
				fetchImpl: request.fetchImpl,
				mimeType: request.mimeType || "image/png",
				filename: request.filename || "crop.png",
				model,
				quality: request.quality,
				size: request.size,
				user: request.user,
			});
			return {
				provider: this.id,
				model: result.model,
				taskType: "image",
				buffer: result.buffer,
				usage: result.usage,
				requestMs: result.requestMs,
			};
		}

		// Text task.
		const apiKey = request.apiKey || process.env.OPENAI_API_KEY || serverConfig.openai.apiKey;
		if (!apiKey) {
			throw new AiProviderError("OPENAI_API_KEY is required for OpenAI text tasks", "ai_provider_key_missing", false);
		}
		const startedAt = Date.now();
		const response = await (request.fetchImpl || fetch)(OPENAI_RESPONSES_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ model, input: request.prompt }),
		});
		const requestMs = Date.now() - startedAt;
		if (!response.ok) {
			const status = response.status;
			throw new AiProviderError(
				`OpenAI text error ${status}`,
				"ai_provider_text_failed",
				status === 408 || status === 409 || status === 429 || status >= 500,
			);
		}
		const payload = (await response.json()) as {
			output_text?: string;
			output?: Array<{ content?: Array<{ text?: string }> }>;
			usage?: unknown;
		};
		const text = payload.output_text || payload.output?.[0]?.content?.[0]?.text || "";
		return { provider: this.id, model, taskType: "text", text, usage: payload.usage, requestMs };
	}
}

export const openAiProvider = new OpenAiProvider();
