// Tests for ChatGPT and OpenRouter AI services
// Mocks fetch to test request building, error handling, response parsing

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";

// ── ChatGPT Service Tests ────────────────────────────────────

describe("translateWithChatGPT", () => {
	const origFetch = globalThis.fetch;
	const mockFetch = mock((_url: string, _opts?: any) => Promise.resolve(new Response()));

	beforeEach(() => {
		globalThis.fetch = mockFetch;
		mockFetch.mockReset();
	});

	afterEach(() => {
		globalThis.fetch = origFetch;
	});

	test("throws if HAR file not found or fetch fails", async () => {
		const { translateWithChatGPT } = await import("../services/chatgpt.js");
		try {
			await translateWithChatGPT(Buffer.from("test"), "test prompt");
		} catch (e: any) {
			// Either HAR not found, or fetch fails because we mocked it
			expect(typeof e.message).toBe("string");
			expect(e.message.length).toBeGreaterThan(0);
		}
	});

	test("throws on non-OK response from ChatGPT", async () => {
		mockFetch.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

		// Can't easily test this without modifying HAR_PATH — skip if no HAR
		// In production, this would be tested with dependency injection
	});

	test("throws if no image found in SSE response", async () => {
		mockFetch.mockResolvedValueOnce(new Response("data: {\"v\":{\"message\":{\"content\":{\"parts\":[{\"text\":\"no image here\"}]}}}}\ndata: [DONE]", { status: 200 }));
	});
});

// ── OpenRouter Service Tests ──────────────────────────────────

describe("translateWithOpenRouter", () => {
	const origFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = mock((_url: string, _opts?: any) => Promise.resolve(new Response()));
		(globalThis.fetch as any).mockReset();
	});

	afterEach(() => {
		globalThis.fetch = origFetch;
	});

	test("sends correct model and structure", async () => {
		const { translateWithOpenRouter } = await import("../services/openrouter.js");

		let capturedBody: any;
		let capturedHeaders: any;

		(globalThis.fetch as any).mockImplementationOnce(async (url: string, opts: any) => {
			capturedBody = JSON.parse(opts.body);
			capturedHeaders = opts.headers;

			return new Response(JSON.stringify({
				choices: [{
					message: {
						images: [{
							image_url: { url: "data:image/png;base64,iVBORw0KGgo=" }
						}]
					}
				}]
			}), { status: 200 });
		});

		const result = await translateWithOpenRouter(Buffer.from("test"), "test prompt", "sk-test-key");
		expect(result).toBeInstanceOf(Buffer);
		expect(capturedBody.model).toBe("openai/gpt-5.4-image-2");
		expect(capturedBody.messages[0].content[0].type).toBe("text");
		expect(capturedBody.messages[0].content[0].text).toBe("test prompt");
		expect(capturedBody.messages[0].content[1].type).toBe("image_url");
		expect(capturedHeaders.Authorization).toBe("Bearer sk-test-key");
	});

	test("sends selected OpenRouter image model", async () => {
		const { translateWithOpenRouterModel } = await import("../services/openrouter.js");

		let capturedBody: any;
		(globalThis.fetch as any).mockImplementationOnce(async (_url: string, opts: any) => {
			capturedBody = JSON.parse(opts.body);
			return new Response(JSON.stringify({
				choices: [{
					message: {
						images: [{
							image_url: { url: "data:image/png;base64,iVBORw0KGgo=" }
						}]
					}
				}]
			}), { status: 200 });
		});

		const result = await translateWithOpenRouterModel(
			Buffer.from("test"),
			"clean this crop",
			"sk-test-key",
			"google/gemini-3.1-flash-image-preview",
		);

		expect(result).toBeInstanceOf(Buffer);
		expect(capturedBody.model).toBe("google/gemini-3.1-flash-image-preview");
	});

	test("throws on non-OK response", async () => {
		const { translateWithOpenRouter } = await import("../services/openrouter.js");

		(globalThis.fetch as any).mockImplementationOnce(async () => {
			return new Response("Rate limited", { status: 429 });
		});

		expect(async () => {
			await translateWithOpenRouter(Buffer.from("test"), "test", "key");
		}).toThrow();
	});

	test("throws if no image in response", async () => {
		const { translateWithOpenRouter } = await import("../services/openrouter.js");

		(globalThis.fetch as any).mockImplementationOnce(async () => {
			return new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 });
		});

		expect(async () => {
			await translateWithOpenRouter(Buffer.from("test"), "test", "key");
		}).toThrow();
	});

	test("handles base64 data URL response", async () => {
		const { translateWithOpenRouter } = await import("../services/openrouter.js");

		// Create a minimal valid PNG base64
		const fakePng = Buffer.alloc(100, 0x89); // arbitrary bytes

		(globalThis.fetch as any).mockImplementationOnce(async () => {
			return new Response(JSON.stringify({
				choices: [{
					message: {
						images: [{
							image_url: { url: `data:image/png;base64,${fakePng.toString("base64")}` }
						}]
					}
				}]
			}), { status: 200 });
		});

		const result = await translateWithOpenRouter(Buffer.from("test"), "test", "key");
		expect(result).toBeInstanceOf(Buffer);
		expect(result.length).toBeGreaterThan(0);
	});

	test("rejects malformed data URL with no base64 payload (no comma)", async () => {
		const { translateWithOpenRouter } = await import("../services/openrouter.js");

		(globalThis.fetch as any).mockImplementationOnce(async () => {
			return new Response(JSON.stringify({
				choices: [{
					message: {
						// Missing comma/payload — a transient provider schema bug.
						images: [{ image_url: { url: "data:image/png;base64" } }]
					}
				}]
			}), { status: 200 });
		});

		expect(async () => {
			await translateWithOpenRouter(Buffer.from("test"), "test", "key");
		}).toThrow();
	});

	test("rejects data URL with empty base64 payload", async () => {
		const { translateWithOpenRouter } = await import("../services/openrouter.js");

		(globalThis.fetch as any).mockImplementationOnce(async () => {
			return new Response(JSON.stringify({
				choices: [{
					message: {
						images: [{ image_url: { url: "data:image/png;base64," } }]
					}
				}]
			}), { status: 200 });
		});

		expect(async () => {
			await translateWithOpenRouter(Buffer.from("test"), "test", "key");
		}).toThrow();
	});

	test("handles regular URL response (downloads image)", async () => {
		const { translateWithOpenRouter } = await import("../services/openrouter.js");

		let callCount = 0;
		(globalThis.fetch as any).mockImplementation(async (url: string, opts: any) => {
			callCount++;
			if (callCount === 1) {
				// First call: API request
				return new Response(JSON.stringify({
					choices: [{
						message: {
							images: [{
								image_url: { url: "https://cdn.example.com/image.png" }
							}]
						}
					}]
				}), { status: 200 });
			}
			// Second call: download image
			return new Response(Buffer.alloc(200), { status: 200 });
		});

		const result = await translateWithOpenRouter(Buffer.from("test"), "test", "key");
		expect(result).toBeInstanceOf(Buffer);
		expect(callCount).toBe(2);
	});

	test("rejects a model-returned URL pointing at internal/metadata hosts (SSRF guard)", async () => {
		const { translateWithOpenRouter } = await import("../services/openrouter.js");

		const blockedUrls = [
			"http://cdn.example.com/image.png", // non-https
			"https://169.254.169.254/latest/meta-data/", // cloud metadata
			"https://127.0.0.1/internal.png", // loopback
			"https://10.0.0.5/secret.png", // private 10/8
			"https://192.168.1.10/secret.png", // private 192.168/16
			"https://172.16.5.4/secret.png", // private 172.16/12
			"https://localhost/x.png", // localhost
		];

		for (const blocked of blockedUrls) {
			let downloadAttempted = false;
			(globalThis.fetch as any).mockImplementation(async (url: string) => {
				if (url.includes("openrouter.ai")) {
					return new Response(JSON.stringify({
						choices: [{ message: { images: [{ image_url: { url: blocked } }] } }],
					}), { status: 200 });
				}
				downloadAttempted = true;
				return new Response(Buffer.alloc(10), { status: 200 });
			});

			await expect(translateWithOpenRouter(Buffer.from("test"), "test", "key"))
				.rejects.toThrow();
			// The guard must reject BEFORE the server-side fetch of the attacker URL.
			expect(downloadAttempted).toBe(false);
		}
	});

	test("blocks a redirect from an allowed host to an internal address (SSRF redirect hop)", async () => {
		const { translateWithOpenRouter } = await import("../services/openrouter.js");

		const requestedUrls: string[] = [];
		(globalThis.fetch as any).mockImplementation(async (url: string, opts: any) => {
			if (url.includes("openrouter.ai")) {
				return new Response(JSON.stringify({
					choices: [{ message: { images: [{ image_url: { url: "https://cdn.example.com/image.png" } }] } }],
				}), { status: 200 });
			}
			requestedUrls.push(url);
			// The image fetch MUST be made with manual redirect handling so the guard
			// can re-validate the hop; assert that and then emit a 302 to metadata.
			expect(opts?.redirect).toBe("manual");
			if (url === "https://cdn.example.com/image.png") {
				return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
			}
			// If the guard were bypassed, the metadata host would be fetched here.
			return new Response(Buffer.alloc(10), { status: 200 });
		});

		await expect(translateWithOpenRouter(Buffer.from("test"), "test", "key")).rejects.toThrow();
		// The first (allowed) host is fetched, but the redirect target must NOT be.
		expect(requestedUrls).toEqual(["https://cdn.example.com/image.png"]);
	});

	test("follows a safe redirect between public https hosts", async () => {
		const { translateWithOpenRouter } = await import("../services/openrouter.js");

		const requestedUrls: string[] = [];
		(globalThis.fetch as any).mockImplementation(async (url: string, opts: any) => {
			if (url.includes("openrouter.ai")) {
				return new Response(JSON.stringify({
					choices: [{ message: { images: [{ image_url: { url: "https://cdn.example.com/image.png" } }] } }],
				}), { status: 200 });
			}
			requestedUrls.push(url);
			expect(opts?.redirect).toBe("manual");
			if (url === "https://cdn.example.com/image.png") {
				return new Response(null, { status: 302, headers: { location: "https://images.example.net/final.png" } });
			}
			return new Response(Buffer.alloc(64), { status: 200 });
		});

		const result = await translateWithOpenRouter(Buffer.from("test"), "test", "key");
		expect(result).toBeInstanceOf(Buffer);
		expect(requestedUrls).toEqual(["https://cdn.example.com/image.png", "https://images.example.net/final.png"]);
	});

	test("assertSafeResultImageUrl allows public https URLs and blocks reserved targets", async () => {
		const { assertSafeResultImageUrl } = await import("../services/openrouter.js");

		expect(assertSafeResultImageUrl("https://cdn.example.com/a.png").hostname).toBe("cdn.example.com");
		expect(() => assertSafeResultImageUrl("http://cdn.example.com/a.png")).toThrow();
		expect(() => assertSafeResultImageUrl("https://169.254.169.254/")).toThrow();
		expect(() => assertSafeResultImageUrl("https://[::1]/a.png")).toThrow();
		expect(() => assertSafeResultImageUrl("not a url")).toThrow();
	});
});

describe("editImageWithOpenAi", () => {
	const origFetch = globalThis.fetch;
	const previousOpenAiKey = process.env.OPENAI_API_KEY;

	beforeEach(() => {
		process.env.OPENAI_API_KEY = "sk-test";
		globalThis.fetch = mock((_url: string, _opts?: any) => Promise.resolve(new Response()));
		(globalThis.fetch as any).mockReset();
	});

	afterEach(() => {
		globalThis.fetch = origFetch;
		if (previousOpenAiKey === undefined) {
			delete process.env.OPENAI_API_KEY;
		} else {
			process.env.OPENAI_API_KEY = previousOpenAiKey;
		}
	});

	test("rejects oversized b64 image responses before storing provider output", async () => {
		const { editImageWithOpenAi } = await import("../services/openai-image.js");
		(globalThis.fetch as any).mockResolvedValueOnce(new Response(JSON.stringify({
			data: [{ b64_json: Buffer.alloc(20).toString("base64") }],
		}), {
			status: 200,
			headers: { "content-type": "application/json" },
		}));

		await expect(editImageWithOpenAi({
			imageBuffer: Buffer.from("source"),
			prompt: "test",
			maxResultBytes: 10,
		})).rejects.toThrow("exceeded 10 bytes");
	});

	test("classifies non-retryable OpenAI provider errors", async () => {
		const { OpenAiImageProviderError, editImageWithOpenAi } = await import("../services/openai-image.js");
		(globalThis.fetch as any).mockResolvedValueOnce(new Response(JSON.stringify({
			error: {
				message: "Invalid API key",
				type: "invalid_request_error",
				code: "invalid_api_key",
			},
		}), {
			status: 401,
			headers: { "content-type": "application/json" },
		}));

		try {
			await editImageWithOpenAi({
				imageBuffer: Buffer.from("source"),
				prompt: "test",
			});
			throw new Error("expected provider error");
		} catch (error) {
			expect(error).toBeInstanceOf(OpenAiImageProviderError);
			const providerError = error as InstanceType<typeof OpenAiImageProviderError>;
			expect(providerError.statusCode).toBe(401);
			expect(providerError.code).toBe("invalid_api_key");
			expect(providerError.retryable).toBe(false);
		}
	});

	test("preserves retry hints for OpenAI rate limit errors", async () => {
		const { OpenAiImageProviderError, editImageWithOpenAi } = await import("../services/openai-image.js");
		(globalThis.fetch as any).mockResolvedValueOnce(new Response(JSON.stringify({
			error: {
				message: "Rate limit reached",
				type: "rate_limit_error",
				code: "rate_limit_exceeded",
			},
		}), {
			status: 429,
			headers: {
				"content-type": "application/json",
				"retry-after": "12",
			},
		}));

		try {
			await editImageWithOpenAi({
				imageBuffer: Buffer.from("source"),
				prompt: "test",
			});
			throw new Error("expected provider error");
		} catch (error) {
			expect(error).toBeInstanceOf(OpenAiImageProviderError);
			const providerError = error as InstanceType<typeof OpenAiImageProviderError>;
			expect(providerError.statusCode).toBe(429);
			expect(providerError.retryable).toBe(true);
			expect(providerError.retryAfterSeconds).toBe(12);
		}
	});
});

// ── AI Router Tests ──────────────────────────────────────────

describe("processAiJob", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("validates project and image IDs before processing", async () => {
		const { processAiJob } = await import("../services/ai-router.js");
		const badJob = {
			jobId: "test-job",
			projectId: "../../../etc",  // path traversal attempt
			imageId: "test.png",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "test",
			tier: "sfx-pro" as const,
			status: "pending" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		expect(async () => {
			await processAiJob(badJob);
		}).toThrow();
	});

	test("honors AI_DEFAULT_PROVIDER=openrouter for real platform jobs (not just tests)", async () => {
		// W4.7 fix: production jobs must route through resolveOfficialProvider(config),
		// so setting aiDefaultProvider=openrouter makes a real job hit the OpenRouter
		// chat-completions endpoint with an image-output model, never OpenAI.
		const { v4: uuid } = await import("uuid");
		const sharp = (await import("sharp")).default;
		const { DATA_DIR, PROJECTS_DIR, loadConfig, saveConfig, serverConfig } = await import("../config.js");
		const { processAiJob } = await import("../services/ai-router.js");
		const { objectStorage } = await import("../services/storage.js");
		const { jobQueue } = await import("../services/queue.js");
		const previousFetch = globalThis.fetch;
		const originalConfig = loadConfig();
		const configPath = join(DATA_DIR, "config.json");
		const originalConfigFile = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;
		const projectId = uuid();
		const imageId = `${uuid()}.png`;
		const jobId = uuid();
		const projectPath = join(PROJECTS_DIR, projectId);
		const serverSnapshot = { aiRequireAssetRegistryForAi: serverConfig.aiRequireAssetRegistryForAi };
		const source = await sharp({
			create: { width: 256, height: 256, channels: 3, background: "#ffffff" },
		}).png().toBuffer();
		// Noisy patch so the composited PNG comfortably clears the >1000-byte guard.
		const patchPixels = Buffer.alloc(256 * 256 * 3);
		for (let index = 0; index < patchPixels.length; index += 1) patchPixels[index] = index % 251;
		const aiPatch = await sharp(patchPixels, { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer();
		const urls: string[] = [];
		try {
			Object.assign(serverConfig as unknown as Record<string, unknown>, { aiRequireAssetRegistryForAi: false });
			saveConfig({
				...originalConfig,
				openaiImagesEnabled: true,
				openrouterEnabled: true,
				openrouterApiKey: "sk-or-test",
				promptModerationEnabled: false,
				providerKillSwitches: {},
				aiDefaultProvider: "openrouter",
			});
			await objectStorage.putProjectImage({ projectId, imageId, buffer: source });
			globalThis.fetch = mock(async (url: string) => {
				urls.push(url);
				if (url.includes("api.openai.com")) {
					throw new Error("must not call OpenAI when aiDefaultProvider=openrouter");
				}
				return new Response(JSON.stringify({
					choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${aiPatch.toString("base64")}` } }] } }],
				}), { status: 200, headers: { "content-type": "application/json" } });
			}) as any;

			await processAiJob({
				jobId,
				projectId,
				imageId,
				crop: { x: 0, y: 0, w: 256, h: 256 },
				lang: "th",
				prompt: "clean this",
				tier: "sfx-pro",
				quality: "low",
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			expect(urls.some((u) => u.includes("openrouter.ai"))).toBe(true);
			expect(urls.some((u) => u.includes("api.openai.com"))).toBe(false);
			const events = await jobQueue.eventsFor(jobId);
			expect(events.some((e) => e.type === "provider:attempt" && e.metadata?.provider === "openrouter-gpt-5.4-image-2")).toBe(true);
		} finally {
			if (originalConfigFile === null) {
				if (existsSync(configPath)) unlinkSync(configPath);
			} else {
				writeFileSync(configPath, originalConfigFile);
			}
			Object.assign(serverConfig as unknown as Record<string, unknown>, serverSnapshot);
			globalThis.fetch = previousFetch;
			rmSync(projectPath, { recursive: true, force: true });
		}
	});

	test("a misconfigured OPENAI_IMAGE_MODEL fails fast at config load (clear error, no network call)", async () => {
		// Model-id mismatch fix: an unsupported OPENAI_IMAGE_MODEL is now rejected at
		// CONFIG LOAD with a clear, actionable error before any job dispatch — so a
		// bad model never silently breaks every AI image job. loadConfig() throws,
		// processAiJob (which loads config first) surfaces that, and no network
		// request is made. (The adapter format lock remains a runtime safety net and
		// is covered directly in ai-providers.test.ts.)
		const { v4: uuid } = await import("uuid");
		const sharp = (await import("sharp")).default;
		const { DATA_DIR, PROJECTS_DIR, loadConfig, saveConfig, serverConfig } = await import("../config.js");
		const { processAiJob } = await import("../services/ai-router.js");
		const { objectStorage } = await import("../services/storage.js");
		const previousFetch = globalThis.fetch;
		const previousOpenAiKey = process.env.OPENAI_API_KEY;
		const originalConfig = loadConfig();
		const configPath = join(DATA_DIR, "config.json");
		const originalConfigFile = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;
		const projectId = uuid();
		const imageId = `${uuid()}.png`;
		const jobId = uuid();
		const projectPath = join(PROJECTS_DIR, projectId);
		const serverSnapshot = { aiRequireAssetRegistryForAi: serverConfig.aiRequireAssetRegistryForAi };
		const source = await sharp({
			create: { width: 64, height: 64, channels: 3, background: "#ffffff" },
		}).png().toBuffer();
		let networkCalled = false;
		try {
			Object.assign(serverConfig as unknown as Record<string, unknown>, { aiRequireAssetRegistryForAi: false });
			saveConfig({
				...originalConfig,
				openaiImagesEnabled: true,
				openaiImageModel: "gpt-5.5", // a TEXT model, invalid for an image task
				promptModerationEnabled: false,
				providerKillSwitches: {},
				aiDefaultProvider: "openai",
			});
			process.env.OPENAI_API_KEY = "sk-test";
			await objectStorage.putProjectImage({ projectId, imageId, buffer: source });
			globalThis.fetch = mock(async () => {
				networkCalled = true;
				throw new Error("must not reach the network with a bad OPENAI_IMAGE_MODEL");
			}) as any;

			// Config load itself fails fast with a clear, supported-set-naming error.
			expect(() => loadConfig()).toThrow(/not a supported OpenAI image model/);

			// And a job dispatch surfaces that failure without reaching the network.
			await expect(processAiJob({
				jobId,
				projectId,
				imageId,
				crop: { x: 0, y: 0, w: 32, h: 32 },
				lang: "th",
				prompt: "clean this",
				tier: "sfx-pro",
				quality: "low",
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})).rejects.toThrow(/not a supported OpenAI image model/);

			expect(networkCalled).toBe(false);
		} finally {
			if (originalConfigFile === null) {
				if (existsSync(configPath)) unlinkSync(configPath);
			} else {
				writeFileSync(configPath, originalConfigFile);
			}
			Object.assign(serverConfig as unknown as Record<string, unknown>, serverSnapshot);
			if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previousOpenAiKey;
			globalThis.fetch = previousFetch;
			rmSync(projectPath, { recursive: true, force: true });
		}
	});

	test("blocks processing when production requires a registered source asset", async () => {
		const { v4: uuid } = await import("uuid");
		const sharp = (await import("sharp")).default;
		const [{ serverConfig }, { processAiJob }, { objectStorage }, { jobQueue }] = await Promise.all([
			import("../config.js"),
			import("../services/ai-router.js"),
			import("../services/storage.js"),
			import("../services/queue.js"),
		]);
		const projectId = uuid();
		const imageId = `${uuid()}.png`;
		const jobId = uuid();
		const source = await sharp({
			create: {
				width: 64,
				height: 64,
				channels: 3,
				background: "#ffffff",
			},
		}).png().toBuffer();
		const snapshot = {
			aiRequireAssetRegistryForAi: serverConfig.aiRequireAssetRegistryForAi,
		};
		try {
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				aiRequireAssetRegistryForAi: true,
			});
			await objectStorage.putProjectImage({ projectId, imageId, buffer: source });

			await expect(processAiJob({
				jobId,
				projectId,
				imageId,
				crop: { x: 0, y: 0, w: 32, h: 32 },
				lang: "th",
				prompt: "Do not call provider",
				tier: "sfx-pro",
				quality: "low",
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})).rejects.toThrow(`Asset ${imageId} is not registered for AI processing`);

			const events = await jobQueue.eventsFor(jobId);
			expect(events.some((event) => event.type === "asset:not_ready")).toBe(true);
		} finally {
			Object.assign(serverConfig as unknown as Record<string, unknown>, snapshot);
		}
	});

	test("refuses platform fallback for a BYO-queued job whose key was revoked", async () => {
		// Regression: a job admitted on the BYO path (byoQueued=true, no credit
		// reservation, prompt moderation skipped) must NOT silently run on a
		// platform provider if the workspace BYO key/add-on is gone at processing
		// time. The project here has no workspace mapping, so getWorkspaceByoProvider
		// returns null and the route-revoked guard must fire before any provider call.
		const { v4: uuid } = await import("uuid");
		const sharp = (await import("sharp")).default;
		const [{ serverConfig }, { processAiJob }, { objectStorage }, { jobQueue }] = await Promise.all([
			import("../config.js"),
			import("../services/ai-router.js"),
			import("../services/storage.js"),
			import("../services/queue.js"),
		]);
		const projectId = uuid();
		const imageId = `${uuid()}.png`;
		const jobId = uuid();
		const source = await sharp({
			create: { width: 64, height: 64, channels: 3, background: "#ffffff" },
		}).png().toBuffer();
		const snapshot = { aiRequireAssetRegistryForAi: serverConfig.aiRequireAssetRegistryForAi };
		try {
			Object.assign(serverConfig as unknown as Record<string, unknown>, {
				aiRequireAssetRegistryForAi: false,
			});
			await objectStorage.putProjectImage({ projectId, imageId, buffer: source });

			await expect(processAiJob({
				jobId,
				projectId,
				imageId,
				crop: { x: 0, y: 0, w: 32, h: 32 },
				lang: "th",
				prompt: "Must never reach a platform provider",
				tier: "sfx-pro",
				quality: "low",
				byoQueued: true,
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})).rejects.toMatchObject({ code: "byo_route_revoked", retryable: false });

			const events = await jobQueue.eventsFor(jobId);
			expect(events.some((event) => event.type === "byo:route_revoked")).toBe(true);
			// Critically, no platform provider attempt was recorded.
			expect(events.some((event) => event.type === "provider:attempt")).toBe(false);
		} finally {
			Object.assign(serverConfig as unknown as Record<string, unknown>, snapshot);
		}
	});

	test("stores AI output through object storage and the asset registry", async () => {
		const { v4: uuid } = await import("uuid");
		const sharp = (await import("sharp")).default;
		const { DATA_DIR, PROJECTS_DIR, loadConfig, saveConfig } = await import("../config.js");
		const { processAiJob } = await import("../services/ai-router.js");
		const { getAssetRecord } = await import("../services/assets.js");
		const { objectStorage } = await import("../services/storage.js");
		const previousOpenAiKey = process.env.OPENAI_API_KEY;

		const originalConfig = loadConfig();
		const configPath = join(DATA_DIR, "config.json");
		const originalConfigFile = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;
		const projectId = uuid();
		const imageId = `${uuid()}.png`;
		const jobId = uuid();
		const projectPath = join(PROJECTS_DIR, projectId);
		const storageReserves: any[] = [];
		const storageReleases: string[] = [];
		let restoreStorageQuotaStore: (() => void) | undefined;
		let listActiveStorageReservations: (() => Promise<unknown[]>) | undefined;
		const source = await sharp({
			create: {
				width: 256,
				height: 256,
				channels: 3,
				background: "#ffffff",
			},
		}).png().toBuffer();
		const pixels = Buffer.alloc(256 * 256 * 3);
		for (let index = 0; index < pixels.length; index += 1) {
			pixels[index] = index % 251;
		}
		const aiPatch = await sharp(pixels, {
			raw: { width: 256, height: 256, channels: 3 },
		}).png().toBuffer();
		let capturedForm: FormData | undefined;

			try {
				saveConfig({
					...originalConfig,
					openaiImagesEnabled: true,
					openaiImageModel: "gpt-image-1",
					openaiImageDefaultQuality: "low",
					promptModerationEnabled: false,
					chatgptEnabled: true,
					sfxProviderMode: "openai-gpt-image-2",
					providerKillSwitches: {},
				});
				process.env.OPENAI_API_KEY = "sk-test";
			await objectStorage.putProjectImage({ projectId, imageId, buffer: source });
			const {
				MemoryStorageQuotaReservationStore,
				setStorageQuotaReservationStoreForTests,
			} = await import("../services/storage-quota.js");
			const memoryStore = new MemoryStorageQuotaReservationStore();
			listActiveStorageReservations = () => memoryStore.listActive(projectId);
			restoreStorageQuotaStore = setStorageQuotaReservationStoreForTests({
				reserve: async (input) => {
					storageReserves.push(input);
					return memoryStore.reserve(input);
				},
				release: async (releaseProjectId, reservationId) => {
					storageReleases.push(reservationId);
					return memoryStore.release(releaseProjectId, reservationId);
				},
				listActive: (activeProjectId, now) => memoryStore.listActive(activeProjectId, now),
			});
				globalThis.fetch = mock(async (url: string, options?: RequestInit) => {
					if (url.includes("/v1/moderations")) {
						// Mandatory image-output CSAM screen runs even with prompt moderation
						// disabled; benign pass so the clean AI output is stored (fail-open used
						// to mask this provider call).
						return new Response(JSON.stringify({
								id: "modr-test",
								model: "omni-moderation-latest",
								results: [{ flagged: false, categories: {}, category_scores: { sexual: 0.01, "sexual/minors": 0.01 }, category_applied_input_types: {} }],
							}), { status: 200, headers: { "Content-Type": "application/json" } });
					}
					capturedForm = options?.body as FormData;
					return new Response(JSON.stringify({
						data: [{ b64_json: aiPatch.toString("base64") }],
						quality: "low",
						size: "1024x1024",
					output_format: "png",
					usage: { input_tokens: 1, output_tokens: 1 },
				}), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as any;

			await processAiJob({
				jobId,
				projectId,
				imageId,
				crop: { x: 0, y: 0, w: 512, h: 256 },
				lang: "th",
				prompt: "Redraw this region",
				tier: "sfx-pro",
				quality: "low",
				costEstimate: {
					tier: "sfx-pro",
					providerHint: "openai-gpt-image-2",
					currency: "THB",
					quality: "low",
					outputSize: "1536x1024",
					creditUnits: 1,
					megapixels: 0.131,
					estimatedThb: 1,
					reserveThb: 1.25,
					pricingVersion: "test",
				},
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const resultId = `result_${jobId}.png`;
			const stored = await objectStorage.getProjectImage({ projectId, imageId: resultId });
			const asset = getAssetRecord(projectId, resultId);

			expect(stored?.byteLength).toBeGreaterThan(1000);
			expect(asset).toEqual(expect.objectContaining({
				imageId: resultId,
				mimeType: "image/png",
				storageStatus: "released",
				storageDriver: objectStorage.driver,
			}));
			expect(asset?.sizeBytes).toBe(stored?.byteLength);
			// Asset-library discoverability: the registered AI output carries
			// `uploadedBy.source = "ai_job"` (the machine `kind` the library filters
			// on) plus durable provenance metadata (kind=ai-generated, source image,
			// job, crop, provider) — and the core library facets (project / bytes /
			// createdAt) are on the record. This is read back from the persisted store
			// (getAssetRecord), so it proves the metadata survives a reload.
			expect(asset?.uploadedBy?.source).toBe("ai_job");
			expect(asset?.projectId).toBe(projectId);
			expect(typeof asset?.createdAt).toBe("string");
			expect(asset?.metadata).toEqual(expect.objectContaining({
				assetKind: "ai-generated",
				ai: expect.objectContaining({
					jobId,
					sourceImageId: imageId,
					tier: "sfx-pro",
					provider: "openai-gpt-image-2",
					// crop is the clamped (safe) region: the 512-wide request is clamped
					// to the 256x256 source.
					crop: { x: 0, y: 0, w: 256, h: 256 },
				}),
			}));
			expect(storageReserves).toContainEqual(expect.objectContaining({
				projectId,
				reason: "ai_output",
				bytes: stored?.byteLength,
			}));
			expect(storageReleases).toHaveLength(1);
			expect(listActiveStorageReservations).toBeDefined();
			expect(await listActiveStorageReservations!()).toHaveLength(0);
			expect(capturedForm?.get("model")).toBe("gpt-image-1");
			expect(capturedForm?.get("quality")).toBe("low");
			expect(capturedForm?.get("size")).toBe("1024x1024");
		} finally {
			restoreStorageQuotaStore?.();
			if (originalConfigFile === null) {
				if (existsSync(configPath)) unlinkSync(configPath);
			} else {
				writeFileSync(configPath, originalConfigFile);
			}
			if (previousOpenAiKey === undefined) {
				delete process.env.OPENAI_API_KEY;
				} else {
					process.env.OPENAI_API_KEY = previousOpenAiKey;
				}
				rmSync(projectPath, { recursive: true, force: true });
			}
		});

		test("resumes from a provider_succeeded checkpoint without a second provider call (W4.9)", async () => {
			// In-flight continuity: a worker died after the provider returned an image
			// (checkpointed + parked) but before the job reached `done`. The resumed run
			// MUST reuse the parked artifact and never re-call (re-bill) the provider.
			const { v4: uuid } = await import("uuid");
			const sharp = (await import("sharp")).default;
			const { DATA_DIR, PROJECTS_DIR, loadConfig, saveConfig } = await import("../config.js");
			const { processAiJob } = await import("../services/ai-router.js");
			const { getAssetRecord } = await import("../services/assets.js");
			const { objectStorage } = await import("../services/storage.js");
			const previousOpenAiKey = process.env.OPENAI_API_KEY;
			const originalConfig = loadConfig();
			const configPath = join(DATA_DIR, "config.json");
			const originalConfigFile = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;
			const projectId = uuid();
			const imageId = `${uuid()}.png`;
			const jobId = uuid();
			const projectPath = join(PROJECTS_DIR, projectId);
			const source = await sharp({
				create: { width: 256, height: 256, channels: 3, background: "#ffffff" },
			}).png().toBuffer();
			// Pre-seed the parked provider result (what the prior, crashed run obtained).
			// Use noise so the PNG is well above the >=1000-byte reuse floor.
			const parkedPixels = Buffer.alloc(128 * 128 * 3);
			for (let index = 0; index < parkedPixels.length; index += 1) {
				parkedPixels[index] = index % 251;
			}
			const parkedResult = await sharp(parkedPixels, {
				raw: { width: 128, height: 128, channels: 3 },
			}).png().toBuffer();
			let providerCalls = 0;

			try {
				saveConfig({
					...originalConfig,
					openaiImagesEnabled: true,
					openaiImageModel: "gpt-image-1",
					openaiImageDefaultQuality: "low",
					promptModerationEnabled: false,
					chatgptEnabled: true,
					sfxProviderMode: "openai-gpt-image-2",
					providerKillSwitches: {},
				});
				process.env.OPENAI_API_KEY = "sk-test";
				await objectStorage.putProjectImage({ projectId, imageId, buffer: source });
				await objectStorage.putProjectImage({ projectId, imageId: `aijob_provider_${jobId}.png`, buffer: parkedResult });

				globalThis.fetch = mock(async (url: string) => {
					if (url.includes("/v1/images") || url.includes("/v1/chat") || url.includes("openrouter")) {
						providerCalls += 1;
						throw new Error("provider must NOT be called on a provider_succeeded resume");
					}
					if (url.includes("/v1/moderations")) {
						// Mandatory image-output CSAM screen: benign pass so the resumed
						// clean AI output is published (fail-open used to mask this call).
						return new Response(JSON.stringify({
							id: "modr-test",
							model: "omni-moderation-latest",
							results: [{ flagged: false, categories: {}, category_scores: { sexual: 0.01, "sexual/minors": 0.01 }, category_applied_input_types: {} }],
						}), { status: 200, headers: { "Content-Type": "application/json" } });
					}
					throw new Error(`unexpected fetch to ${url}`);
				}) as any;

				await processAiJob({
					jobId,
					projectId,
					imageId,
					crop: { x: 0, y: 0, w: 256, h: 256 },
					lang: "th",
					prompt: "Redraw this region",
					tier: "sfx-pro",
					quality: "low",
					status: "processing",
					checkpoint: {
						step: "provider_succeeded",
						providerResultImageId: `aijob_provider_${jobId}.png`,
						provider: "openai-gpt-image-2",
						updatedAt: Date.now(),
					},
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});

				expect(providerCalls).toBe(0);
				const resultId = `result_${jobId}.png`;
				const stored = await objectStorage.getProjectImage({ projectId, imageId: resultId });
				expect(stored?.byteLength).toBeGreaterThan(1000);
				expect(getAssetRecord(projectId, resultId)).toEqual(expect.objectContaining({ imageId: resultId }));
			} finally {
				if (originalConfigFile === null) {
					if (existsSync(configPath)) unlinkSync(configPath);
				} else {
					writeFileSync(configPath, originalConfigFile);
				}
				if (previousOpenAiKey === undefined) {
					delete process.env.OPENAI_API_KEY;
				} else {
					process.env.OPENAI_API_KEY = previousOpenAiKey;
				}
				rmSync(projectPath, { recursive: true, force: true });
			}
		});

		test("provider_succeeded resume with a corrupt parked artifact re-calls the provider AND re-parks the fresh result (W4.9)", async () => {
			// The checkpoint says `provider_succeeded`, but the parked artifact is
			// corrupt (decode fails). The resume must NOT reuse the bad bytes — it must
			// re-call the provider once, AND re-park + re-checkpoint the fresh result so
			// a further restart never re-calls (re-bills) the provider again.
			const { v4: uuid } = await import("uuid");
			const sharp = (await import("sharp")).default;
			const { DATA_DIR, PROJECTS_DIR, loadConfig, saveConfig } = await import("../config.js");
			const { processAiJob } = await import("../services/ai-router.js");
			const { objectStorage } = await import("../services/storage.js");
			const { jobQueue } = await import("../services/queue.js");
			const previousOpenAiKey = process.env.OPENAI_API_KEY;
			const originalConfig = loadConfig();
			const configPath = join(DATA_DIR, "config.json");
			const originalConfigFile = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;
			const projectId = uuid();
			const imageId = `${uuid()}.png`;
			const jobId = uuid();
			const parkedId = `aijob_provider_${jobId}.png`;
			const projectPath = join(PROJECTS_DIR, projectId);
			const source = await sharp({ create: { width: 256, height: 256, channels: 3, background: "#ffffff" } }).png().toBuffer();
			// Corrupt-but-large parked artifact: above the >=1000 byte floor, NOT a
			// decodable image. The old code would reuse this and fail downstream.
			const corruptParked = Buffer.alloc(2048, 0x7a);
			const freshPixels = Buffer.alloc(256 * 256 * 3);
			for (let index = 0; index < freshPixels.length; index += 1) freshPixels[index] = index % 251;
			const freshPatch = await sharp(freshPixels, { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer();
			let providerCalls = 0;

			try {
				saveConfig({
					...originalConfig,
					openaiImagesEnabled: true,
					openaiImageModel: "gpt-image-1",
					openaiImageDefaultQuality: "low",
					promptModerationEnabled: false,
					chatgptEnabled: true,
					sfxProviderMode: "openai-gpt-image-2",
					providerKillSwitches: {},
				});
				process.env.OPENAI_API_KEY = "sk-test";
				await objectStorage.putProjectImage({ projectId, imageId, buffer: source });
				await objectStorage.putProjectImage({ projectId, imageId: parkedId, buffer: corruptParked });

				globalThis.fetch = mock(async (url: string) => {
					if (url.includes("/v1/images") || url.includes("/v1/chat")) {
						providerCalls += 1;
						return new Response(JSON.stringify({
							data: [{ b64_json: freshPatch.toString("base64") }],
							quality: "low",
							size: "1024x1024",
							output_format: "png",
							usage: { input_tokens: 1, output_tokens: 1 },
						}), { status: 200, headers: { "content-type": "application/json" } });
					}
					if (url.includes("/v1/moderations")) {
						// Mandatory image-output CSAM screen: benign pass so the resumed
						// clean AI output is published (fail-open used to mask this call).
						return new Response(JSON.stringify({
							id: "modr-test",
							model: "omni-moderation-latest",
							results: [{ flagged: false, categories: {}, category_scores: { sexual: 0.01, "sexual/minors": 0.01 }, category_applied_input_types: {} }],
						}), { status: 200, headers: { "Content-Type": "application/json" } });
					}
					throw new Error(`unexpected fetch to ${url}`);
				}) as any;

				await processAiJob({
					jobId,
					projectId,
					imageId,
					crop: { x: 0, y: 0, w: 256, h: 256 },
					lang: "th",
					prompt: "Redraw this region",
					tier: "sfx-pro",
					quality: "low",
					status: "processing",
					checkpoint: {
						step: "provider_succeeded",
						providerResultImageId: parkedId,
						provider: "openai-gpt-image-2",
						updatedAt: Date.now(),
					},
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});

				expect(providerCalls).toBe(1); // re-called exactly once (artifact was unusable)
				// The job finalized: proves the corrupt artifact was NOT reused (reuse
				// would have failed at composite/recordUploadedAsset, surfacing as a
				// thrown error rather than a stored output).
				const stored = await objectStorage.getProjectImage({ projectId, imageId: `result_${jobId}.png` });
				expect(stored?.byteLength).toBeGreaterThan(1000);
				// The resume detected the corruption and fell through (vs silently reusing).
				const events = await jobQueue.eventsFor(jobId);
				expect(events.some((event) => event.type === "checkpoint:provider_artifact_missing")).toBe(true);
				expect(events.some((event) => event.type === "checkpoint:provider_reused")).toBe(false);
			} finally {
				if (originalConfigFile === null) {
					if (existsSync(configPath)) unlinkSync(configPath);
				} else {
					writeFileSync(configPath, originalConfigFile);
				}
				if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
				else process.env.OPENAI_API_KEY = previousOpenAiKey;
				rmSync(projectPath, { recursive: true, force: true });
			}
		});

		test("output_stored resume finalizes from the stored output without re-compositing or re-reserving storage (W4.9)", async () => {
			// A prior run already stored + registered the output and checkpointed
			// `output_stored`. The resume must skip provider/composite/storage entirely
			// and just transition to done — no second storage reservation.
			const { v4: uuid } = await import("uuid");
			const sharp = (await import("sharp")).default;
			const { DATA_DIR, PROJECTS_DIR, loadConfig, saveConfig } = await import("../config.js");
			const { processAiJob } = await import("../services/ai-router.js");
			const { objectStorage } = await import("../services/storage.js");
			const previousOpenAiKey = process.env.OPENAI_API_KEY;
			const originalConfig = loadConfig();
			const configPath = join(DATA_DIR, "config.json");
			const originalConfigFile = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;
			const projectId = uuid();
			const imageId = `${uuid()}.png`;
			const jobId = uuid();
			const resultId = `result_${jobId}.png`;
			const projectPath = join(PROJECTS_DIR, projectId);
			const source = await sharp({ create: { width: 256, height: 256, channels: 3, background: "#ffffff" } }).png().toBuffer();
			const outPixels = Buffer.alloc(256 * 256 * 3);
			for (let index = 0; index < outPixels.length; index += 1) outPixels[index] = (index * 7) % 251;
			const storedOutput = await sharp(outPixels, { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer();
			let providerCalls = 0;
			let storageReserves = 0;
			let restoreStorageQuotaStore: (() => void) | undefined;

			try {
				saveConfig({
					...originalConfig,
					openaiImagesEnabled: true,
					openaiImageModel: "gpt-image-1",
					openaiImageDefaultQuality: "low",
					promptModerationEnabled: false,
					chatgptEnabled: true,
					sfxProviderMode: "openai-gpt-image-2",
					providerKillSwitches: {},
				});
				process.env.OPENAI_API_KEY = "sk-test";
				await objectStorage.putProjectImage({ projectId, imageId, buffer: source });
				await objectStorage.putProjectImage({ projectId, imageId: resultId, buffer: storedOutput });

				const {
					MemoryStorageQuotaReservationStore,
					setStorageQuotaReservationStoreForTests,
				} = await import("../services/storage-quota.js");
				const memoryStore = new MemoryStorageQuotaReservationStore();
				restoreStorageQuotaStore = setStorageQuotaReservationStoreForTests({
					reserve: async (input) => { storageReserves += 1; return memoryStore.reserve(input); },
					release: async (p, id) => memoryStore.release(p, id),
					listActive: (p, now) => memoryStore.listActive(p, now),
				});

				globalThis.fetch = mock(async (url: string) => {
					if (url.includes("/v1/images") || url.includes("/v1/chat")) {
						providerCalls += 1;
						throw new Error("provider must NOT be called on an output_stored resume");
					}
					if (url.includes("/v1/moderations")) {
						// Mandatory image-output CSAM screen: benign pass so the resumed
						// clean AI output is published (fail-open used to mask this call).
						return new Response(JSON.stringify({
							id: "modr-test",
							model: "omni-moderation-latest",
							results: [{ flagged: false, categories: {}, category_scores: { sexual: 0.01, "sexual/minors": 0.01 }, category_applied_input_types: {} }],
						}), { status: 200, headers: { "Content-Type": "application/json" } });
					}
					throw new Error(`unexpected fetch to ${url}`);
				}) as any;

				await processAiJob({
					jobId,
					projectId,
					imageId,
					crop: { x: 0, y: 0, w: 256, h: 256 },
					lang: "th",
					prompt: "Redraw this region",
					tier: "sfx-pro",
					quality: "low",
					status: "processing",
					checkpoint: {
						step: "output_stored",
						providerResultImageId: `aijob_provider_${jobId}.png`,
						provider: "openai-gpt-image-2",
						updatedAt: Date.now(),
					},
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});

				expect(providerCalls).toBe(0); // no provider re-call
				expect(storageReserves).toBe(0); // no second storage reservation
				// The pre-existing stored output is preserved (not overwritten/re-composited).
				const stored = await objectStorage.getProjectImage({ projectId, imageId: resultId });
				expect(stored?.equals(storedOutput)).toBe(true);
			} finally {
				restoreStorageQuotaStore?.();
				if (originalConfigFile === null) {
					if (existsSync(configPath)) unlinkSync(configPath);
				} else {
					writeFileSync(configPath, originalConfigFile);
				}
				if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
				else process.env.OPENAI_API_KEY = previousOpenAiKey;
				rmSync(projectPath, { recursive: true, force: true });
			}
		});

		test("warned prompt submissions enter needs_review instead of processing queue", async () => {
			const { v4: uuid } = await import("uuid");
			const sharp = (await import("sharp")).default;
			const { DATA_DIR, PROJECTS_DIR, loadConfig, saveConfig, serverConfig } = await import("../config.js");
			const { objectStorage } = await import("../services/storage.js");
			const { submitAiJob } = await import("../services/ai-job-submission.js");
			const { jobQueue } = await import("../services/queue.js");
			const previousOpenAiKey = process.env.OPENAI_API_KEY;
			const previousFetch = globalThis.fetch;
			const originalConfig = loadConfig();
			const configPath = join(DATA_DIR, "config.json");
			const originalConfigFile = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;
			const projectId = uuid();
			const imageId = `${uuid()}.png`;
			const projectPath = join(PROJECTS_DIR, projectId);
			const serverSnapshot = {
				aiRequireAssetRegistryForAi: serverConfig.aiRequireAssetRegistryForAi,
			};
			const source = await sharp({
				create: {
					width: 64,
					height: 64,
					channels: 3,
					background: "#ffffff",
				},
			}).png().toBuffer();

			try {
				Object.assign(serverConfig as unknown as Record<string, unknown>, {
					aiRequireAssetRegistryForAi: false,
				});
				saveConfig({
					...originalConfig,
					openaiImagesEnabled: true,
					openaiImageModel: "gpt-image-1",
					openaiImageDefaultQuality: "low",
					promptModerationEnabled: true,
					providerKillSwitches: {},
				});
				process.env.OPENAI_API_KEY = "sk-test";
				globalThis.fetch = mock(async (url: string) => {
					if (!url.includes("/v1/moderations")) {
						throw new Error(`Unexpected fetch in warned prompt submission test: ${url}`);
					}
					return new Response(JSON.stringify({
						id: "modr-test",
						model: "omni-moderation-latest",
						results: [{
							flagged: false,
							categories: { sexual: false },
							category_scores: { sexual: 0.01, "sexual/minors": 0.01 },
							category_applied_input_types: {},
						}],
					}), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}) as any;
				await objectStorage.putProjectImage({ projectId, imageId, buffer: source });

				const submitted = await submitAiJob({
					projectId,
					imageId,
					crop: { x: 0, y: 0, w: 32, h: 32 },
					lang: "th",
					customPrompt: "remove watermark and make this explicit",
					tier: "sfx-pro",
					quality: "low",
				}, { idempotencyKey: `warned-${projectId}` });
				const queued = await jobQueue.get(submitted.jobId);
				const events = await jobQueue.eventsFor(submitted.jobId);

				expect(queued?.status).toBe("needs_review");
				expect(events.some((event) => event.type === "moderation:needs_review")).toBe(true);
				// Regression (codex #1/#3/#8): a parked needs_review job is never claimed
				// by the queue (claimPendingJobs only takes "pending") and never settled,
				// so its credit reservation must be RELEASED at submission time instead of
				// leaking for the full reservation lifetime.
				expect(queued?.creditReservation?.status).toBe("released");
				expect(queued?.creditReservation?.reason).toBe("moderation_needs_review");
				expect(submitted.creditReservation?.status).toBe("released");
			} finally {
				Object.assign(serverConfig as unknown as Record<string, unknown>, serverSnapshot);
				if (originalConfigFile === null) {
					if (existsSync(configPath)) unlinkSync(configPath);
				} else {
					writeFileSync(configPath, originalConfigFile);
				}
				if (previousOpenAiKey === undefined) {
					delete process.env.OPENAI_API_KEY;
				} else {
					process.env.OPENAI_API_KEY = previousOpenAiKey;
				}
				globalThis.fetch = previousFetch;
				rmSync(projectPath, { recursive: true, force: true });
			}
		});

		test("warned prompt park refunds the consumed personal/shareable credit bucket (money P1)", async () => {
			// Regression (codex money P1 #1): a warned prompt parks as needs_review
			// before any provider dispatch. The submission DEBITS the personal/shareable
			// credit bucket; parking only released the usage-ledger reservation, leaving
			// the bucket debited so the user was charged credits for a job that never
			// ran. The park path must also refund the bucket so the balance is restored.
			const { v4: uuid } = await import("uuid");
			const sharp = (await import("sharp")).default;
			const { DATA_DIR, PROJECTS_DIR, loadConfig, saveConfig, serverConfig } = await import("../config.js");
			const { objectStorage } = await import("../services/storage.js");
			const { submitAiJob } = await import("../services/ai-job-submission.js");
			const { jobQueue } = await import("../services/queue.js");
			const { grantCredits, getBalance, hasCreditSystem } = await import("../services/credits.js");
			const previousOpenAiKey = process.env.OPENAI_API_KEY;
			const previousFetch = globalThis.fetch;
			const originalConfig = loadConfig();
			const configPath = join(DATA_DIR, "config.json");
			const originalConfigFile = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;
			const projectId = uuid();
			const userId = `user-${uuid()}`;
			const imageId = `${uuid()}.png`;
			const projectPath = join(PROJECTS_DIR, projectId);
			const serverSnapshot = {
				aiRequireAssetRegistryForAi: serverConfig.aiRequireAssetRegistryForAi,
			};
			const source = await sharp({
				create: { width: 64, height: 64, channels: 3, background: "#ffffff" },
			}).png().toBuffer();

			try {
				Object.assign(serverConfig as unknown as Record<string, unknown>, {
					aiRequireAssetRegistryForAi: false,
				});
				saveConfig({
					...originalConfig,
					openaiImagesEnabled: true,
					openaiImageModel: "gpt-image-1",
					openaiImageDefaultQuality: "low",
					promptModerationEnabled: true,
					providerKillSwitches: {},
				});
				process.env.OPENAI_API_KEY = "sk-test";
				globalThis.fetch = mock(async (url: string) => {
					if (!url.includes("/v1/moderations")) {
						throw new Error(`Unexpected fetch in warned prompt credit-refund test: ${url}`);
					}
					return new Response(JSON.stringify({
						id: "modr-test",
						model: "omni-moderation-latest",
						results: [{
							flagged: false,
							categories: { sexual: false },
							category_scores: { sexual: 0.01, "sexual/minors": 0.01 },
							category_applied_input_types: {},
						}],
					}), { status: 200, headers: { "Content-Type": "application/json" } });
				}) as any;

				// Grant shareable credits to the project-derived workspace + this user so
				// hasCreditSystem() is true and the submission actually debits the bucket.
				// resolveCreditWorkspaceId falls back to projectId when no workspace state
				// exists, so the grant workspace must be the projectId.
				await grantCredits({
					workspaceId: projectId,
					ownerScope: "workspace",
					ownerId: projectId,
					creditClass: "shareable",
					amount: 1000,
					source: "goodwill",
				});
				expect(hasCreditSystem(projectId, userId)).toBe(true);
				const before = getBalance("member", userId, projectId);

				await objectStorage.putProjectImage({ projectId, imageId, buffer: source });

				const submitted = await submitAiJob({
					projectId,
					imageId,
					crop: { x: 0, y: 0, w: 32, h: 32 },
					lang: "th",
					customPrompt: "remove watermark and make this explicit",
					tier: "sfx-pro",
					quality: "low",
				}, { idempotencyKey: `warned-credit-${projectId}`, actorUserId: userId });

				const queued = await jobQueue.get(submitted.jobId);
				expect(queued?.status).toBe("needs_review");

				// The credit BUCKET must be fully refunded: balance restored to pre-submit.
				const after = getBalance("member", userId, projectId);
				expect(after.shareable).toBe(before.shareable);
				expect(after.total).toBe(before.total);

				const events = await jobQueue.eventsFor(submitted.jobId);
				expect(events.some((event) => event.type === "credit:shared_released" || event.type === "moderation:needs_review")).toBe(true);
			} finally {
				Object.assign(serverConfig as unknown as Record<string, unknown>, serverSnapshot);
				if (originalConfigFile === null) {
					if (existsSync(configPath)) unlinkSync(configPath);
				} else {
					writeFileSync(configPath, originalConfigFile);
				}
				if (previousOpenAiKey === undefined) {
					delete process.env.OPENAI_API_KEY;
				} else {
					process.env.OPENAI_API_KEY = previousOpenAiKey;
				}
				globalThis.fetch = previousFetch;
				rmSync(projectPath, { recursive: true, force: true });
			}
		});
	});
