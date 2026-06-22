// W4.7 — Official AI provider router tests.
//
// Covers: provider selection by task type (format lock), the configured-default
// provider resolution, Python-disabled routing (the dormant worker is excluded
// from the SFX availability set by default), BYO-key usage through an adapter,
// and that the moderation gate is not bypassed by the new provider path.

import { describe, expect, test } from "bun:test";
import {
	AiProviderError,
	DEFAULT_OPENAI_IMAGE_MODEL,
	OFFICIAL_PROVIDER_IDS,
	OPENAI_IMAGE_MODELS,
	getOfficialProvider,
	isSupportedOpenAiImageModel,
	openAiProvider,
	openRouterProvider,
	resolveOfficialProvider,
	resolveProviderModel,
} from "../services/ai-providers/index.js";
import { canUseSfxProvider, listAvailableSfxProviders } from "../services/provider-controls.js";
import { readAiDefaultProviderEnv, readAiPythonEnabledEnv, defaultAiPythonEnabled } from "../config.js";
import type { AppConfig } from "../types/index.js";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
	return {
		openrouterEnabled: true,
		openrouterApiKey: "sk-or-test",
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
		...overrides,
	};
}

/** A fetch double that records the request and returns a canned provider payload. */
function recordingFetch(payload: unknown): { fetchImpl: typeof fetch; calls: Array<{ url: string; body: any; headers: any }> } {
	const calls: Array<{ url: string; body: any; headers: any }> = [];
	const fetchImpl = (async (url: RequestInfo | URL, opts?: RequestInit) => {
		// The OpenAI image-edit path sends FormData (not JSON); only parse string bodies.
		let body: any;
		if (typeof opts?.body === "string") {
			try {
				body = JSON.parse(opts.body);
			} catch {
				body = opts.body;
			}
		}
		calls.push({ url: String(url), body, headers: opts?.headers });
		return Response.json(payload);
	}) as typeof fetch;
	return { fetchImpl, calls };
}

describe("ai-providers: format-locked model selection by task type", () => {
	test("OpenAI image task resolves to an image-output model; text to a text model", () => {
		// gpt-image-1 is OpenAI's real image-edit model id and matches the `.env`
		// default (OPENAI_IMAGE_MODEL=gpt-image-1) — see the model-id mismatch fix.
		expect(resolveProviderModel(openAiProvider, "image")).toBe("gpt-image-1");
		expect(openAiProvider.modelsForTask("image")).toEqual(["gpt-image-1"]);
		expect(resolveProviderModel(openAiProvider, "text")).toBe("gpt-5.5");
		expect(openAiProvider.modelsForTask("text")).not.toContain("gpt-image-1");
	});

	test("OpenRouter image task resolves to an image-output model; text to a text model", () => {
		expect(resolveProviderModel(openRouterProvider, "image")).toBe("openai/gpt-5.4-image-2");
		expect(openRouterProvider.modelsForTask("image")).toContain("openai/gpt-5.4-image-2");
		expect(resolveProviderModel(openRouterProvider, "text")).toBe("openai/gpt-5.5");
		expect(openRouterProvider.modelsForTask("text")).not.toContain("openai/gpt-5.4-image-2");
	});

	test("a text model handed to an image task is rejected (format lock)", async () => {
		await expect(
			openAiProvider.run({ taskType: "image", prompt: "x", model: "gpt-5.5", imageBuffer: Buffer.from("img"), apiKey: "sk-test" }),
		).rejects.toMatchObject({ code: "ai_provider_format_lock" });
		await expect(
			openRouterProvider.run({ taskType: "image", prompt: "x", model: "openai/gpt-5.5", imageBuffer: Buffer.from("img"), apiKey: "sk-or" }),
		).rejects.toMatchObject({ code: "ai_provider_format_lock" });
	});

	test("an image model handed to a text task is rejected (format lock)", async () => {
		await expect(
			openAiProvider.run({ taskType: "text", prompt: "x", model: "gpt-image-1", apiKey: "sk-test" }),
		).rejects.toBeInstanceOf(AiProviderError);
	});

	test("the allow-list contains OpenAI's real image model and matches the adapter default", () => {
		// Regression guard for the env↔allow-list mismatch: the configured `.env`
		// default (OPENAI_IMAGE_MODEL=gpt-image-1) MUST be a member of the allow-list
		// the format lock enforces, otherwise every AI image job throws
		// "not an OpenAI image model" and dies.
		expect(OPENAI_IMAGE_MODELS).toContain("gpt-image-1");
		expect(DEFAULT_OPENAI_IMAGE_MODEL).toBe("gpt-image-1");
		expect(isSupportedOpenAiImageModel("gpt-image-1")).toBe(true);
		// The old fake id must NOT be accepted.
		expect(isSupportedOpenAiImageModel("gpt-image-2")).toBe(false);
		expect(OPENAI_IMAGE_MODELS).not.toContain("gpt-image-2");
	});

	test("the configured real model passes the format lock; a bogus one fails fast (no network)", async () => {
		const { fetchImpl, calls } = recordingFetch({
			data: [{ b64_json: Buffer.from("a".repeat(2000)).toString("base64") }],
			usage: { input_tokens: 1 },
		});

		// Valid real model → reaches the (mocked) network, no format-lock throw.
		const ok = await openAiProvider.run({
			taskType: "image",
			prompt: "clean",
			model: DEFAULT_OPENAI_IMAGE_MODEL,
			imageBuffer: Buffer.from("source"),
			apiKey: "sk-test",
			fetchImpl,
		});
		expect(ok.buffer?.byteLength).toBeGreaterThan(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toContain("/images/edits");

		// Bogus model → rejected by the format lock BEFORE any (additional) network call.
		await expect(
			openAiProvider.run({
				taskType: "image",
				prompt: "clean",
				model: "gpt-image-2",
				imageBuffer: Buffer.from("source"),
				apiKey: "sk-test",
				fetchImpl,
			}),
		).rejects.toMatchObject({ code: "ai_provider_format_lock" });
		// No new network call was made for the rejected model.
		expect(calls).toHaveLength(1);
	});
});

describe("ai-providers: default provider resolution", () => {
	test("only OpenAI and OpenRouter are registered (locked decision)", () => {
		expect([...OFFICIAL_PROVIDER_IDS].sort()).toEqual(["openai", "openrouter"]);
		expect(getOfficialProvider("openai").id).toBe("openai");
		expect(getOfficialProvider("openrouter").id).toBe("openrouter");
	});

	test("resolveOfficialProvider honors aiDefaultProvider, defaulting to OpenAI", () => {
		expect(resolveOfficialProvider(config()).id).toBe("openai");
		expect(resolveOfficialProvider(config({ aiDefaultProvider: "openrouter" })).id).toBe("openrouter");
	});

	test("AI_DEFAULT_PROVIDER env parsing: default openai, valid values, malformed throws", () => {
		expect(readAiDefaultProviderEnv(undefined)).toBe("openai");
		expect(readAiDefaultProviderEnv("")).toBe("openai");
		expect(readAiDefaultProviderEnv("OpenRouter")).toBe("openrouter");
		expect(readAiDefaultProviderEnv("openai")).toBe("openai");
		expect(() => readAiDefaultProviderEnv("anthropic")).toThrow();
	});
});

describe("ai-providers: Python-disabled routing", () => {
	test("Python worker is dormant by default (config default false)", () => {
		expect(defaultAiPythonEnabled()).toBe(false);
		expect(config().aiPythonEnabled).toBe(false);
	});

	test("with AI_PYTHON_ENABLED off, SFX availability excludes the Python worker", () => {
		const previous = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "sk-test";
		try {
			const available = listAvailableSfxProviders(config({ aiPythonEnabled: false }));
			expect(available).not.toContain("python-worker");
			// Official providers remain available.
			expect(available).toContain("openai-gpt-image-2");
			expect(available).toContain("openrouter-gpt-5.4-image-2");
			expect(canUseSfxProvider(config({ aiPythonEnabled: false }), "python-worker")).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previous;
		}
	});

	test("AI_PYTHON_ENABLED parsing fails closed: typos disable the worker, never inherit persisted true", () => {
		// Absent/empty env → use the persisted/default fallback.
		expect(readAiPythonEnabledEnv(undefined, false)).toBe(false);
		expect(readAiPythonEnabledEnv(undefined, true)).toBe(true);
		expect(readAiPythonEnabledEnv("", true)).toBe(true);
		// Explicit truthy → on.
		expect(readAiPythonEnabledEnv("true", false)).toBe(true);
		expect(readAiPythonEnabledEnv("1", false)).toBe(true);
		expect(readAiPythonEnabledEnv("ON", false)).toBe(true);
		// Explicit falsy → off.
		expect(readAiPythonEnabledEnv("false", true)).toBe(false);
		expect(readAiPythonEnabledEnv("0", true)).toBe(false);
		// Present-but-unrecognized (typo) MUST fail closed to off even when the
		// persisted fallback is true — this is the W4.7 fix.
		expect(readAiPythonEnabledEnv("flase", true)).toBe(false);
		expect(readAiPythonEnabledEnv("enable", true)).toBe(false);
	});

	test("explicit AI_PYTHON_ENABLED on re-enables the legacy worker (dev only)", () => {
		const cfg = config({ aiPythonEnabled: true, chatgptEnabled: true });
		expect(canUseSfxProvider(cfg, "python-worker")).toBe(true);
		expect(listAvailableSfxProviders(cfg)).toContain("python-worker");
	});

	test("even enabled, the worker stays off if chatgptEnabled is false", () => {
		expect(canUseSfxProvider(config({ aiPythonEnabled: true, chatgptEnabled: false }), "python-worker")).toBe(false);
	});
});

describe("ai-providers: BYO key usage through adapters", () => {
	test("OpenAI adapter forwards the BYO key as the bearer token, not a platform key", async () => {
		const { fetchImpl, calls } = recordingFetch({
			data: [{ b64_json: Buffer.from("a".repeat(2000)).toString("base64") }],
			usage: { input_tokens: 1 },
		});
		const result = await openAiProvider.run({
			taskType: "image",
			prompt: "clean this",
			imageBuffer: Buffer.from("source"),
			apiKey: "sk-byo-customer",
			fetchImpl,
		});
		expect(result.provider).toBe("openai");
		expect(result.buffer?.byteLength).toBeGreaterThan(0);
		expect(calls[0]?.url).toContain("/images/edits");
		expect((calls[0]?.headers as Record<string, string>)?.Authorization).toBe("Bearer sk-byo-customer");
	});

	test("OpenRouter text adapter uses the BYO key and a text model", async () => {
		const { fetchImpl, calls } = recordingFetch({
			choices: [{ message: { content: "translated" } }],
			usage: { total_tokens: 5 },
		});
		const result = await openRouterProvider.run({
			taskType: "text",
			prompt: "translate",
			apiKey: "sk-or-byo",
			fetchImpl,
		});
		expect(result.text).toBe("translated");
		expect(result.model).toBe("openai/gpt-5.5");
		expect(calls[0]?.url).toContain("openrouter.ai");
		expect((calls[0]?.headers as Record<string, string>)?.Authorization).toBe("Bearer sk-or-byo");
	});

	test("OpenRouter adapter refuses to run without any key (no silent env fallback)", async () => {
		await expect(
			openRouterProvider.run({ taskType: "text", prompt: "x" }),
		).rejects.toMatchObject({ code: "ai_provider_key_missing" });
	});

	test("OpenRouter image HTTP failures surface as retryable AiProviderError (status-derived)", async () => {
		// W4.7 fix: the image branch must wrap plain Errors from
		// translateWithOpenRouterModel into AiProviderError with a status-derived
		// retryable flag so the queue keeps reliable retry/fallback metadata.
		const fail = (status: number): typeof fetch =>
			(async () => new Response("upstream body", { status })) as typeof fetch;

		// 429 → retryable.
		await expect(
			openRouterProvider.run({
				taskType: "image",
				prompt: "x",
				imageBuffer: Buffer.from("img"),
				apiKey: "sk-or",
				model: "openai/gpt-5.4-image-2",
				fetchImpl: fail(429),
			}),
		).rejects.toMatchObject({ code: "ai_provider_image_failed", retryable: true });

		// 503 → retryable.
		await expect(
			openRouterProvider.run({
				taskType: "image",
				prompt: "x",
				imageBuffer: Buffer.from("img"),
				apiKey: "sk-or",
				model: "openai/gpt-5.4-image-2",
				fetchImpl: fail(503),
			}),
		).rejects.toMatchObject({ code: "ai_provider_image_failed", retryable: true });

		// 400 → non-retryable.
		await expect(
			openRouterProvider.run({
				taskType: "image",
				prompt: "x",
				imageBuffer: Buffer.from("img"),
				apiKey: "sk-or",
				model: "openai/gpt-5.4-image-2",
				fetchImpl: fail(400),
			}),
		).rejects.toMatchObject({ code: "ai_provider_image_failed", retryable: false });
	});
});

describe("ai-providers: adapters are pure transport (moderation is not their job)", () => {
	test("adapters never import or call moderation — moderation stays in front in ai-router", async () => {
		// The provider abstraction is intentionally a thin transport layer. The
		// prompt-moderation gate runs in ai-router before any adapter dispatch and
		// BYO image jobs run a mandatory CSAM check in byo-api. Assert the adapter
		// source does not reference moderation so the gate can never be relocated
		// behind the transport (which would let it be bypassed).
		const { readFileSync } = await import("fs");
		const { join } = await import("path");
		const dir = join(import.meta.dir, "..", "services", "ai-providers");
		for (const file of ["openai.ts", "openrouter.ts", "index.ts", "types.ts"]) {
			const src = readFileSync(join(dir, file), "utf8");
			// No call into the moderation service from inside the transport layer.
			expect(src).not.toMatch(/from\s+["'][^"']*moderation/);
			expect(src).not.toMatch(/moderatePrompt|moderateImage|moderateImageBuffer/);
		}
	});
});
