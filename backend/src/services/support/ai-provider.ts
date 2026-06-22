// AI-support — OpenAI chat-completions wrapper with tool-calling.
//
// A thin, BOUNDED client the support agent loop drives. It does ONE OpenAI
// chat.completions round-trip per call and returns either an assistant message
// (final text) or a set of tool calls for the loop to execute and feed back. It
// deliberately does NOT own the loop, the cost guard, or the token accounting —
// the agent (ai-agent.ts) does, after the MANDATORY admission gate.
//
// Cost containment lives here too:
//   * max_completion_tokens is capped (SUPPORT_AGENT_MAX_TOKENS) so a single reply
//     can't run away.
//   * the agent caps the number of round-trips; this module just executes one.
//   * model defaults to gpt-5.5 (SUPPORT_AGENT_MODEL), validated at config load.
//
// DISABLED-SAFE: if no OpenAI key is resolvable the provider reports
// `isEnabled() === false` and complete() throws a typed, non-retryable error — the
// agent checks isEnabled() first and hands off to a human instead of crashing.

import { loadConfig, serverConfig } from "../../config.js";

const OPENAI_CHAT_ENDPOINT = "https://api.openai.com/v1/chat/completions";

export type SupportChatRole = "system" | "user" | "assistant" | "tool";

/** A JSON-schema tool definition the model may call (OpenAI `tools[].function`). */
export interface SupportToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** A tool call the model emitted on an assistant turn. */
export interface SupportToolCall {
	id: string;
	name: string;
	/** Raw JSON arguments string exactly as the model produced it. */
	arguments: string;
}

/** One message in the running conversation passed to the model. */
export interface SupportChatMessage {
	role: SupportChatRole;
	content: string;
	/** Present on assistant turns that requested tools. */
	toolCalls?: SupportToolCall[];
	/** Present on tool-result turns: which call this answers. */
	toolCallId?: string;
	/** Tool name on a tool-result turn (OpenAI requires `name` on role:"tool"). */
	name?: string;
}

export interface SupportChatRequest {
	messages: SupportChatMessage[];
	tools: SupportToolDefinition[];
	/** Override the configured model (tests). */
	model?: string;
	/** Override the API key (tests / BYO). */
	apiKey?: string;
	/** Injectable fetch for tests. */
	fetchImpl?: typeof fetch;
	maxTokens?: number;
}

export interface SupportChatUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

export interface SupportChatResult {
	/** Assistant text (may be empty when the turn is purely tool calls). */
	content: string;
	toolCalls: SupportToolCall[];
	usage: SupportChatUsage;
	model: string;
	requestMs: number;
}

export class SupportProviderError extends Error {
	constructor(message: string, readonly code = "support_provider_error", readonly retryable = false) {
		super(message);
		this.name = "SupportProviderError";
	}
}

const DEFAULT_MAX_TOKENS = 700;
// HARD upper bound on a single completion's max_tokens. An operator typo (e.g. an
// extra zero → 80000) must NOT be able to authorize a runaway-cost completion, so the
// configured value is CLAMPED to this ceiling regardless of how large it is set.
const MAX_MAX_TOKENS = 4000;

/** Cap on a single completion's output tokens. Env-tunable but CLAMPED to
 *  [1, MAX_MAX_TOKENS] so an operator typo can neither disable the bound (<=0) nor
 *  blow past a sane ceiling (cost protection); a missing/invalid value uses the default. */
export function readSupportAgentMaxTokens(raw = process.env.SUPPORT_AGENT_MAX_TOKENS, fallback = DEFAULT_MAX_TOKENS): number {
	const trimmed = raw?.trim();
	if (!trimmed) return fallback;
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.min(parsed, MAX_MAX_TOKENS);
}

export interface SupportAiProviderOptions {
	apiKey?: string;
	model?: string;
	fetchImpl?: typeof fetch;
	maxTokens?: number;
}

/**
 * The support-agent OpenAI client. Construct once and reuse. `isEnabled()` reflects
 * whether a key is resolvable; the agent gates on it so an unset OPENAI_API_KEY
 * disables the agent gracefully (handoff) rather than throwing per reply.
 */
export class SupportAiProvider {
	private readonly fetchImpl: typeof fetch;
	private readonly maxTokens: number;

	constructor(private readonly options: SupportAiProviderOptions = {}) {
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.maxTokens = options.maxTokens ?? readSupportAgentMaxTokens();
	}

	private resolveApiKey(override?: string): string {
		return (override || this.options.apiKey || process.env.OPENAI_API_KEY || serverConfig.openai.apiKey || "").trim();
	}

	private resolveModel(override?: string): string {
		// loadConfig().supportAgentModel is validated against the provider text-model
		// allow-list at config load (default gpt-5.5), so this is always a real model id.
		// A failed config read falls back to the default rather than throwing.
		let configured = "";
		try {
			configured = loadConfig().supportAgentModel ?? "";
		} catch {
			configured = "";
		}
		return (override || this.options.model || configured || "gpt-5.5").trim();
	}

	/** True when an OpenAI key is resolvable — the agent only runs the model when this holds. */
	isEnabled(): boolean {
		return this.resolveApiKey().length > 0;
	}

	get model(): string {
		return this.resolveModel();
	}

	/** One bounded chat.completions round-trip with tool-calling. */
	async complete(request: SupportChatRequest): Promise<SupportChatResult> {
		const apiKey = this.resolveApiKey(request.apiKey);
		if (!apiKey) {
			throw new SupportProviderError("OPENAI_API_KEY is required for the support agent", "support_provider_key_missing", false);
		}
		const model = this.resolveModel(request.model);
		const body = {
			model,
			max_completion_tokens: request.maxTokens ?? this.maxTokens,
			messages: request.messages.map(serializeMessage),
			tools: request.tools.map((tool) => ({
				type: "function",
				function: { name: tool.name, description: tool.description, parameters: tool.parameters },
			})),
			tool_choice: "auto" as const,
		};
		const startedAt = Date.now();
		let response: Response;
		try {
			response = await (request.fetchImpl ?? this.fetchImpl)(OPENAI_CHAT_ENDPOINT, {
				method: "POST",
				headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		} catch (error) {
			// Network/transport failure: retryable so the agent can fall back to a handoff.
			throw new SupportProviderError(`Support model request failed: ${error instanceof Error ? error.message : String(error)}`, "support_provider_network", true);
		}
		const requestMs = Date.now() - startedAt;
		if (!response.ok) {
			const status = response.status;
			throw new SupportProviderError(
				`Support model error ${status}`,
				"support_provider_http",
				status === 408 || status === 409 || status === 429 || status >= 500,
			);
		}
		const payload = (await response.json()) as OpenAiChatResponse;
		return parseChatResponse(payload, model, requestMs);
	}
}

interface OpenAiChatResponse {
	choices?: Array<{
		message?: {
			content?: string | null;
			tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
		};
	}>;
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function serializeMessage(message: SupportChatMessage): Record<string, unknown> {
	if (message.role === "assistant" && message.toolCalls?.length) {
		return {
			role: "assistant",
			content: message.content || null,
			tool_calls: message.toolCalls.map((call) => ({
				id: call.id,
				type: "function",
				function: { name: call.name, arguments: call.arguments },
			})),
		};
	}
	if (message.role === "tool") {
		return { role: "tool", content: message.content, tool_call_id: message.toolCallId, name: message.name };
	}
	return { role: message.role, content: message.content };
}

function parseChatResponse(payload: OpenAiChatResponse, model: string, requestMs: number): SupportChatResult {
	const choice = payload.choices?.[0]?.message;
	const toolCalls: SupportToolCall[] = (choice?.tool_calls ?? [])
		.filter((call) => call.function?.name)
		.map((call) => ({
			id: call.id ?? `call_${Math.random().toString(36).slice(2)}`,
			name: call.function!.name!,
			arguments: call.function?.arguments ?? "{}",
		}));
	const usage: SupportChatUsage = {
		promptTokens: safeNumber(payload.usage?.prompt_tokens),
		completionTokens: safeNumber(payload.usage?.completion_tokens),
		totalTokens: safeNumber(payload.usage?.total_tokens),
	};
	// Fall back to prompt+completion when the API omits a total.
	if (usage.totalTokens === 0 && (usage.promptTokens || usage.completionTokens)) {
		usage.totalTokens = usage.promptTokens + usage.completionTokens;
	}
	return { content: (choice?.content ?? "").trim(), toolCalls, usage, model, requestMs };
}

function safeNumber(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Shared default instance — disabled-safe when no key is configured. */
export const supportAiProvider = new SupportAiProvider();
