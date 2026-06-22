import { serverConfig } from "../config.js";
import type { AiImageQuality } from "../types/index.js";

export type OpenAiImageSize = "auto" | "1024x1024" | "1536x1024" | "1024x1536";

export interface OpenAiImageEditInput {
	imageBuffer: Buffer;
	prompt: string;
	apiKey?: string;
	fetchImpl?: typeof fetch;
	mimeType?: string;
	filename?: string;
	model?: string;
	quality?: AiImageQuality;
	size?: OpenAiImageSize;
	user?: string;
	maxResultBytes?: number;
}

export interface OpenAiImageEditResult {
	buffer: Buffer;
	model: string;
	quality: AiImageQuality;
	size?: string;
	outputFormat?: string;
	requestMs: number;
	usage?: unknown;
}

interface OpenAiErrorPayload {
	message: string;
	code?: string;
	type?: string;
}

export class OpenAiImageProviderError extends Error {
	readonly statusCode: number;
	readonly code?: string;
	readonly providerType?: string;
	readonly retryable: boolean;
	readonly retryAfterSeconds?: number;

	constructor(input: {
		statusCode: number;
		message: string;
		code?: string;
		providerType?: string;
		retryable: boolean;
		retryAfterSeconds?: number;
	}) {
		const codeText = input.code ? ` (${input.code})` : "";
		super(`OpenAI image edit error ${input.statusCode}${codeText}: ${input.message}`);
		this.name = "OpenAiImageProviderError";
		this.statusCode = input.statusCode;
		this.code = input.code;
		this.providerType = input.providerType;
		this.retryable = input.retryable;
		this.retryAfterSeconds = input.retryAfterSeconds;
	}
}

const IMAGE_EDIT_ENDPOINT = "https://api.openai.com/v1/images/edits";

export async function editImageWithOpenAi(input: OpenAiImageEditInput): Promise<OpenAiImageEditResult> {
	const apiKey = input.apiKey || process.env.OPENAI_API_KEY || serverConfig.openai.apiKey;
	if (!apiKey) {
		throw new Error("OPENAI_API_KEY is required for OpenAI image editing");
	}

	const model = input.model || serverConfig.openai.imageModel;
	const quality = input.quality || serverConfig.openai.imageDefaultQuality;
	const form = new FormData();
	form.set("model", model);
	form.set("prompt", input.prompt);
	form.set("n", "1");
	form.set("size", input.size || "auto");
	form.set("quality", quality);
	if (input.user) form.set("user", input.user);
	form.set("image", new File(
		[input.imageBuffer],
		input.filename || "source.png",
		{ type: input.mimeType || "image/png" },
	));

	const startedAt = Date.now();
	const response = await (input.fetchImpl || fetch)(IMAGE_EDIT_ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		body: form,
		signal: AbortSignal.timeout(serverConfig.openai.imageRequestTimeoutMs),
	});
	const requestMs = Date.now() - startedAt;
	if (!response.ok) {
		const text = await response.text();
		const providerError = parseOpenAiErrorPayload(text);
		throw new OpenAiImageProviderError({
			statusCode: response.status,
			message: providerError.message,
			code: providerError.code,
			providerType: providerError.type,
			retryable: isRetryableOpenAiImageError(response.status, providerError),
			retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after")),
		});
	}

	const payload = await response.json() as {
		data?: { b64_json?: string }[];
		quality?: string;
		size?: string;
		output_format?: string;
		usage?: unknown;
	};
	const b64 = payload.data?.[0]?.b64_json;
	if (!b64) {
		throw new Error("OpenAI image edit response did not include b64_json");
	}
	const maxResultBytes = input.maxResultBytes ?? serverConfig.openai.imageMaxResultBytes;
	const estimatedResultBytes = estimateBase64DecodedBytes(b64);
	if (estimatedResultBytes > maxResultBytes) {
		throw new Error(`OpenAI image edit response exceeded ${maxResultBytes} bytes`);
	}
	const buffer = Buffer.from(b64, "base64");
	if (buffer.byteLength > maxResultBytes) {
		throw new Error(`OpenAI image edit response exceeded ${maxResultBytes} bytes`);
	}

	return {
		buffer,
		model,
		quality: normalizeQuality(payload.quality, quality),
		size: payload.size,
		outputFormat: payload.output_format,
		requestMs,
		usage: payload.usage,
	};
}

function normalizeQuality(value: unknown, fallback: AiImageQuality): AiImageQuality {
	return value === "low" || value === "medium" || value === "high" ? value : fallback;
}

function estimateBase64DecodedBytes(value: string): number {
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	return Math.floor((value.length * 3) / 4) - padding;
}

function parseOpenAiErrorPayload(text: string): OpenAiErrorPayload {
	try {
		const payload = JSON.parse(text) as { error?: { message?: unknown; code?: unknown; type?: unknown } };
		const error = payload.error ?? {};
		return {
			message: sanitizeProviderMessage(typeof error.message === "string" ? error.message : text),
			code: typeof error.code === "string" ? error.code : undefined,
			type: typeof error.type === "string" ? error.type : undefined,
		};
	} catch {
		return { message: sanitizeProviderMessage(text) };
	}
}

function sanitizeProviderMessage(message: string): string {
	const compact = message.replace(/\s+/g, " ").trim();
	return (compact || "request failed").slice(0, 300);
}

function isRetryableOpenAiImageError(statusCode: number, payload: OpenAiErrorPayload): boolean {
	const code = `${payload.code ?? ""} ${payload.type ?? ""}`.toLowerCase();
	if (code.includes("insufficient_quota") || code.includes("billing") || code.includes("invalid_api_key")) return false;
	if (code.includes("invalid_request") || code.includes("content_policy")) return false;
	return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	const seconds = Number.parseInt(trimmed, 10);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds;
	const dateMs = Date.parse(trimmed);
	if (!Number.isFinite(dateMs)) return undefined;
	return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
}
