// W4.7 — OpenRouter official provider adapter.
//
// Image tasks reuse translateWithOpenRouterModel (image-output chat-completion
// with modalities:["image","text"]). Text tasks use the chat-completions API
// with a text model. The format lock is enforced here.

import { OpenRouterHttpError, translateWithOpenRouterModel } from "../openrouter.js";
import {
	AiProviderError,
	type AiProvider,
	type AiProviderRequest,
	type AiProviderResult,
	type AiProviderTaskType,
} from "./types.js";

// Format-locked model families.
const OPENROUTER_IMAGE_MODELS = ["openai/gpt-5.4-image-2", "google/gemini-2.5-flash-image"] as const;
const OPENROUTER_TEXT_MODELS = ["openai/gpt-5.5", "anthropic/claude-sonnet-4.5", "google/gemini-3.5-pro"] as const;

const OPENROUTER_CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export class OpenRouterProvider implements AiProvider {
	readonly id = "openrouter" as const;

	modelsForTask(taskType: AiProviderTaskType): string[] {
		return taskType === "image" ? [...OPENROUTER_IMAGE_MODELS] : [...OPENROUTER_TEXT_MODELS];
	}

	async run(request: AiProviderRequest): Promise<AiProviderResult> {
		const allowed = this.modelsForTask(request.taskType);
		const model = request.model || allowed[0]!;
		// FORMAT LOCK: keep image and text models on their own task type.
		if (!allowed.includes(model)) {
			throw new AiProviderError(
				`Model '${model}' is not an OpenRouter ${request.taskType} model`,
				"ai_provider_format_lock",
				false,
			);
		}

		// The OpenRouter platform key lives in the runtime AppConfig
		// (config.openrouterApiKey), not in process.env, so the router supplies it
		// via request.apiKey. A BYO key is passed the same way. No silent env
		// fallback here keeps key provenance explicit and prevents leakage.
		const key = request.apiKey || "";
		if (!key) {
			throw new AiProviderError("An OpenRouter API key is required", "ai_provider_key_missing", false);
		}

		if (request.taskType === "image") {
			if (!request.imageBuffer) {
				throw new AiProviderError("imageBuffer is required for image tasks", "ai_provider_image_required", false);
			}
			const startedAt = Date.now();
			let buffer: Buffer;
			try {
				buffer = await translateWithOpenRouterModel(
					request.imageBuffer,
					request.prompt,
					key,
					model,
					request.fetchImpl,
				);
			} catch (error) {
				// Surface the same structured retry metadata the text branch produces so
				// the queue can make reliable retry/fallback decisions on 429/5xx. An
				// HTTP failure carries the upstream status; any other failure (no image
				// in the payload, download error) is non-retryable transport breakage.
				if (error instanceof OpenRouterHttpError) {
					const status = error.status;
					throw new AiProviderError(
						`OpenRouter image error ${status}`,
						"ai_provider_image_failed",
						status === 408 || status === 409 || status === 429 || status >= 500,
					);
				}
				throw new AiProviderError(
					error instanceof Error ? error.message : "OpenRouter image request failed",
					"ai_provider_image_failed",
					false,
				);
			}
			return {
				provider: this.id,
				model,
				taskType: "image",
				buffer,
				requestMs: Date.now() - startedAt,
			};
		}

		// Text task.
		const startedAt = Date.now();
		const response = await (request.fetchImpl || fetch)(OPENROUTER_CHAT_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ model, messages: [{ role: "user", content: request.prompt }] }),
		});
		const requestMs = Date.now() - startedAt;
		if (!response.ok) {
			const status = response.status;
			throw new AiProviderError(
				`OpenRouter text error ${status}`,
				"ai_provider_text_failed",
				status === 408 || status === 409 || status === 429 || status >= 500,
			);
		}
		const payload = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
			usage?: unknown;
		};
		const text = payload.choices?.[0]?.message?.content || "";
		return { provider: this.id, model, taskType: "text", text, usage: payload.usage, requestMs };
	}
}

export const openRouterProvider = new OpenRouterProvider();
