// Codex AI-routing P1 fixes — integration coverage.
//
//  #1 submit-time provider parity: an OpenRouter-default platform (no OpenAI key)
//     can QUEUE a clean job (previously rejected at submit).
//  #2 SFX controls gate execution: sfx-pro disabled mode blocks at submit.
//  #3 ordered provider fallback: a RETRYABLE primary failure falls over to the next
//     configured official provider ONCE (no double-charge — credit capture is at the
//     done transition, which happens once).
//  #4 persisted routing: the resolved provider + model land on the AiJob.
//  #5 honest BYO switch: a BYO failure is reported as a CLIENT resubmit path, not an
//     automatic server-side switch, and is NON-retryable.

import { describe, test, expect, mock, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { v4 as uuid } from "uuid";
import type { AiJob } from "../types/index.js";

async function withConfig<T>(
	overrides: Record<string, unknown>,
	run: (ctx: {
		projectId: string;
		imageId: string;
		source: Buffer;
		aiPatchDataUrl: string;
	}) => Promise<T>,
): Promise<T> {
	const sharp = (await import("sharp")).default;
	const { DATA_DIR, PROJECTS_DIR, loadConfig, saveConfig, serverConfig } = await import("../config.js");
	const { objectStorage } = await import("../services/storage.js");

	const previousOpenAiKey = process.env.OPENAI_API_KEY;
	const originalConfig = loadConfig();
	const configPath = join(DATA_DIR, "config.json");
	const originalConfigFile = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;
	const serverSnapshot = { aiRequireAssetRegistryForAi: serverConfig.aiRequireAssetRegistryForAi };

	const projectId = uuid();
	const imageId = `${uuid()}.png`;
	const projectPath = join(PROJECTS_DIR, projectId);
	const source = await sharp({ create: { width: 128, height: 128, channels: 3, background: "#ffffff" } }).png().toBuffer();
	// A noisy patch so the composited PNG clears the >1000-byte guard.
	const patchPixels = Buffer.alloc(128 * 128 * 3);
	for (let i = 0; i < patchPixels.length; i += 1) patchPixels[i] = i % 251;
	const aiPatch = await sharp(patchPixels, { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer();
	const aiPatchDataUrl = `data:image/png;base64,${aiPatch.toString("base64")}`;

	try {
		mkdirSync(DATA_DIR, { recursive: true });
		mkdirSync(PROJECTS_DIR, { recursive: true });
		Object.assign(serverConfig as unknown as Record<string, unknown>, { aiRequireAssetRegistryForAi: false });
		saveConfig({ ...originalConfig, ...overrides } as never);
		await objectStorage.putProjectImage({ projectId, imageId, buffer: source });
		return await run({ projectId, imageId, source, aiPatchDataUrl });
	} finally {
		Object.assign(serverConfig as unknown as Record<string, unknown>, serverSnapshot);
		if (originalConfigFile === null) {
			if (existsSync(configPath)) unlinkSync(configPath);
		} else {
			writeFileSync(configPath, originalConfigFile);
		}
		if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previousOpenAiKey;
		rmSync(projectPath, { recursive: true, force: true });
	}
}

const previousFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = previousFetch; });

describe("submit-time provider parity (codex P1 #1)", () => {
	test("an OpenRouter-default platform with NO OpenAI key can QUEUE a clean job", async () => {
		delete process.env.OPENAI_API_KEY;
		await withConfig(
			{
				openaiImagesEnabled: false,
				openrouterEnabled: true,
				openrouterApiKey: "sk-or-test",
				aiDefaultProvider: "openrouter",
				promptModerationEnabled: false,
				providerKillSwitches: {},
			},
			async ({ projectId, imageId }) => {
				const { submitAiJob } = await import("../services/ai-job-submission.js");
				// No network needed at submission time.
				globalThis.fetch = mock(async () => { throw new Error("no fetch at submit"); }) as never;
				const submitted = await submitAiJob({
					projectId,
					imageId,
					crop: { x: 0, y: 0, w: 64, h: 64 },
					lang: "en",
					tier: "budget-clean",
					quality: "low",
				}, { idempotencyKey: `or-only-${projectId}` });
				expect(submitted.jobId).toBeTruthy();
				expect(submitted.reused).toBe(false);
			},
		);
	});
});

describe("SFX disabled mode blocks submit (codex P1 #2)", () => {
	test("sfxProviderMode=disabled rejects an sfx-pro submit", async () => {
		await withConfig(
			{
				openaiImagesEnabled: true,
				sfxProviderMode: "disabled",
				promptModerationEnabled: false,
				providerKillSwitches: {},
			},
			async ({ projectId, imageId }) => {
				process.env.OPENAI_API_KEY = "sk-test";
				const { submitAiJob, AiJobSubmissionError } = await import("../services/ai-job-submission.js");
				globalThis.fetch = mock(async () => { throw new Error("no fetch at submit"); }) as never;
				let thrown: unknown;
				try {
					await submitAiJob({
						projectId,
						imageId,
						crop: { x: 0, y: 0, w: 64, h: 64 },
						lang: "en",
						tier: "sfx-pro",
						quality: "low",
					}, { idempotencyKey: `sfx-disabled-${projectId}` });
				} catch (error) {
					thrown = error;
				}
				expect(thrown).toBeInstanceOf(AiJobSubmissionError);
				expect((thrown as InstanceType<typeof AiJobSubmissionError>).status).toBe(409);
				expect((thrown as InstanceType<typeof AiJobSubmissionError>).body.reason).toBe("sfx_provider_disabled");
			},
		);
	});
});

describe("ordered provider fallback + persisted routing (codex P1 #3 + #4)", () => {
	test("a RETRYABLE OpenAI failure falls over to OpenRouter once; resolved provider/model persisted", async () => {
		await withConfig(
			{
				openaiImagesEnabled: true,
				openrouterEnabled: true,
				openrouterApiKey: "sk-or-test",
				aiDefaultProvider: "openai", // OpenAI primary, OpenRouter failover
				sfxProviderMode: "auto",
				promptModerationEnabled: false,
				providerKillSwitches: {},
			},
			async ({ projectId, imageId, aiPatchDataUrl }) => {
				process.env.OPENAI_API_KEY = "sk-test";
				const { processAiJob } = await import("../services/ai-router.js");
				const { jobQueue } = await import("../services/queue.js");

				let openAiCalls = 0;
				let openRouterCalls = 0;
				globalThis.fetch = mock(async (url: string) => {
					// The mandatory CSAM/output-moderation screen (#420) ALWAYS runs once a
					// provider key is present, hitting /v1/moderations. With an OPENAI key set
					// here (OpenAI is the primary IMAGE provider), let that screen PASS so the
					// successful OpenRouter output is published — otherwise the un-stubbed
					// moderation call 503s and the job fails closed to needs_review, masking
					// the fallback-routing assertion this test is about.
					if (url.includes("/v1/moderations")) {
						return new Response(JSON.stringify({
							results: [{ flagged: false, categories: {}, category_scores: {}, category_applied_input_types: {} }],
						}), { status: 200, headers: { "content-type": "application/json" } });
					}
					if (url.includes("api.openai.com")) {
						openAiCalls += 1;
						// 503 → retryable → should fall over to OpenRouter.
						return new Response(JSON.stringify({ error: { message: "upstream busy" } }), { status: 503 });
					}
					openRouterCalls += 1;
					return new Response(JSON.stringify({
						choices: [{ message: { images: [{ image_url: { url: aiPatchDataUrl } }] } }],
					}), { status: 200, headers: { "content-type": "application/json" } });
				}) as never;

				const jobId = uuid();
				const job: AiJob = {
					jobId,
					projectId,
					imageId,
					crop: { x: 0, y: 0, w: 128, h: 128 },
					lang: "en",
					prompt: "clean this",
					tier: "sfx-pro",
					quality: "low",
					status: "pending",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				};
				// Add to the queue so processor updates (status/resolvedProvider) persist and
				// can be read back via jobQueue.get (file/memory store needs no lease). Pass
				// generous admission limits so a shared-singleton queue polluted by earlier
				// tests in the full suite does not reject this add on global capacity.
				await jobQueue.add(job, {
					idempotencyKey: `fallback-${jobId}`,
					admissionLimits: {
						maxOpenJobs: 1_000_000,
						maxPendingJobs: 1_000_000,
						maxProjectOpenJobs: 1_000_000,
						maxProjectPendingJobs: 1_000_000,
						maxProjectReservedThb: Number.MAX_SAFE_INTEGER,
						maxTierOpenJobs: {},
						retryAfterSeconds: 1,
					},
				});
				await processAiJob(job);

				// OpenAI tried (and failed retryably), OpenRouter served the image — exactly
				// one fall-over, OpenRouter called once (no double-dispatch on success).
				expect(openAiCalls).toBeGreaterThanOrEqual(1);
				expect(openRouterCalls).toBe(1);

				const events = await jobQueue.eventsFor(jobId);
				expect(events.some((e) => e.type === "provider:fallback")).toBe(true);
				expect(events.some((e) => e.type === "provider:success" && e.metadata?.provider === "openrouter-gpt-5.4-image-2")).toBe(true);

				const finished = await jobQueue.get(jobId);
				expect(finished?.status).toBe("done");
				// Persisted server-resolved routing (P1 #4): the REAL provider/model, not the
				// static tier hint.
				expect(finished?.resolvedProvider).toBe("openrouter-gpt-5.4-image-2");
				expect(typeof finished?.resolvedModel).toBe("string");
				expect(finished?.resolvedModel!.length).toBeGreaterThan(0);
			},
		);
	});

	// codex P0 round-4 (d): the RAW provider checkpoint `aijob_provider_<jobId>.png` is
	// UNMODERATED. After the job finalizes successfully it MUST be deleted so it cannot
	// linger as a launderable object (and the moderation-gated result is the source of
	// truth). Verify the checkpoint object is gone post-success.
	test("AI checkpoint (aijob_provider_*) is DELETED after a successful job", async () => {
		await withConfig(
			{
				openaiImagesEnabled: false,
				openrouterEnabled: true,
				openrouterApiKey: "sk-or-test",
				aiDefaultProvider: "openrouter",
				sfxProviderMode: "auto",
				promptModerationEnabled: false,
				providerKillSwitches: {},
			},
			async ({ projectId, imageId, aiPatchDataUrl }) => {
				delete process.env.OPENAI_API_KEY;
				const { processAiJob } = await import("../services/ai-router.js");
				const { jobQueue } = await import("../services/queue.js");
				const { objectStorage } = await import("../services/storage.js");

				globalThis.fetch = mock(async () => new Response(JSON.stringify({
					choices: [{ message: { images: [{ image_url: { url: aiPatchDataUrl } }] } }],
				}), { status: 200, headers: { "content-type": "application/json" } })) as never;

				const jobId = uuid();
				const checkpointImageId = `aijob_provider_${jobId}.png`;
				const job: AiJob = {
					jobId,
					projectId,
					imageId,
					crop: { x: 0, y: 0, w: 128, h: 128 },
					lang: "en",
					prompt: "clean this",
					tier: "sfx-pro",
					quality: "low",
					status: "pending",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				};
				await jobQueue.add(job, {
					idempotencyKey: `checkpoint-cleanup-${jobId}`,
					admissionLimits: {
						maxOpenJobs: 1_000_000,
						maxPendingJobs: 1_000_000,
						maxProjectOpenJobs: 1_000_000,
						maxProjectPendingJobs: 1_000_000,
						maxProjectReservedThb: Number.MAX_SAFE_INTEGER,
						maxTierOpenJobs: {},
						retryAfterSeconds: 1,
					},
				});
				await processAiJob(job);

				const finished = await jobQueue.get(jobId);
				expect(finished?.status).toBe("done");
				// The raw, unmoderated provider checkpoint must NOT linger.
				expect(await objectStorage.hasProjectImage({ projectId, imageId: checkpointImageId })).toBe(false);
			},
		);
	});

	test("a DETERMINISTIC (non-retryable) failure does NOT fall over (no second billed call)", async () => {
		await withConfig(
			{
				openaiImagesEnabled: true,
				openrouterEnabled: true,
				openrouterApiKey: "sk-or-test",
				aiDefaultProvider: "openai",
				sfxProviderMode: "auto",
				promptModerationEnabled: false,
				providerKillSwitches: {},
			},
			async ({ projectId, imageId }) => {
				process.env.OPENAI_API_KEY = "sk-test";
				const { processAiJob } = await import("../services/ai-router.js");

				let openRouterCalls = 0;
				globalThis.fetch = mock(async (url: string) => {
					if (url.includes("api.openai.com")) {
						// 400 bad request → NON-retryable → must NOT fall over.
						return new Response(JSON.stringify({ error: { message: "bad request", type: "invalid_request_error" } }), { status: 400 });
					}
					openRouterCalls += 1;
					return new Response(JSON.stringify({ choices: [] }), { status: 200 });
				}) as never;

				let thrown: unknown;
				try {
					await processAiJob({
						jobId: uuid(),
						projectId,
						imageId,
						crop: { x: 0, y: 0, w: 128, h: 128 },
						lang: "en",
						prompt: "clean this",
						tier: "sfx-pro",
						quality: "low",
						status: "pending",
						createdAt: Date.now(),
						updatedAt: Date.now(),
					} as AiJob);
				} catch (error) {
					thrown = error;
				}
				expect(thrown).toBeTruthy();
				// The deterministic OpenAI failure surfaced; OpenRouter was never billed.
				expect(openRouterCalls).toBe(0);
			},
		);
	});
});

// Codex round-2 (revised design): with clampCrop guaranteeing an in-bounds extract
// region, a sharp.extract() throw can only mean a genuinely BROKEN input (corrupt
// image / decoder error). The earlier fix degraded to processing the FULL page, but
// that is wrong on two axes the terminal-failure path gets right:
//   1. BILLING — cost/reservation/admission were sized for the SMALL requested crop;
//      feeding the full page would undercharge and bypass the reserved-credit cap.
//   2. MARKER GEOMETRY — the review marker stays the small rect, so a full-page
//      result would be applied into the small region (wrong geometry).
// So the job must FAIL cleanly: keep the `crop:extract_failed` event, surface a
// sanitized descriptive error, and RELEASE the reserved credit through the queue's
// existing terminal-error transition. We force the extract failure by patching
// Sharp.prototype.extract to throw, leaving every other sharp op intact.
describe("crop extract failure FAILS the job and releases the reservation (codex round-2)", () => {
	test("an in-bounds extract throw produces a FAILED job, the extract_failed event, and a released reservation", async () => {
		delete process.env.OPENAI_API_KEY;
		await withConfig(
			{
				openaiImagesEnabled: false,
				openrouterEnabled: true,
				openrouterApiKey: "sk-or-test",
				aiDefaultProvider: "openrouter",
				sfxProviderMode: "auto",
				promptModerationEnabled: false,
				providerKillSwitches: {},
			},
			async ({ projectId, imageId, aiPatchDataUrl }) => {
				const sharp = (await import("sharp")).default;
				const { processAiJob } = await import("../services/ai-router.js");
				const { jobQueue } = await import("../services/queue.js");
				const { AI_PROVIDER_GENERIC_ERROR } = await import("../utils/ai-error-sanitizer.js");

				// A provider that WOULD succeed — proving the failure is the extract, not
				// the provider call (the job must fail BEFORE any provider dispatch).
				globalThis.fetch = mock(async () => new Response(JSON.stringify({
					choices: [{ message: { images: [{ image_url: { url: aiPatchDataUrl } }] } }],
				}), { status: 200, headers: { "content-type": "application/json" } })) as never;

				// Force the crop extract to throw. Every other sharp op (metadata/png/…)
				// keeps working, so ONLY the extract failure is exercised.
				const sharpProto = Object.getPrototypeOf(
					sharp({ create: { width: 1, height: 1, channels: 3, background: "#fff" } }),
				);
				const originalExtract = sharpProto.extract;
				sharpProto.extract = function forcedThrow(): never {
					throw new Error("forced extract failure (bad extract area)");
				};

				const jobId = uuid();
				// 128x128 source (withConfig); request an in-bounds off-origin sub-rect.
				const requested = { x: 10, y: 20, w: 32, h: 24 };
				const job: AiJob = {
					jobId,
					projectId,
					imageId,
					crop: requested,
					lang: "en",
					prompt: "clean this",
					tier: "sfx-pro",
					quality: "low",
					status: "pending",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					// A reserved credit at submission time — the failure must RELEASE it.
					creditReservation: {
						status: "reserved",
						amountThb: 9,
						currency: "THB",
						createdAt: Date.now(),
					},
				};

				let thrown: unknown;
				try {
					await jobQueue.add(job, {
						idempotencyKey: `extract-fail-${jobId}`,
						admissionLimits: {
							maxOpenJobs: 1_000_000,
							maxPendingJobs: 1_000_000,
							maxProjectOpenJobs: 1_000_000,
							maxProjectPendingJobs: 1_000_000,
							maxProjectReservedThb: Number.MAX_SAFE_INTEGER,
							maxTierOpenJobs: {},
							retryAfterSeconds: 1,
						},
					});
					try {
						await processAiJob(job);
					} catch (error) {
						thrown = error;
					}
				} finally {
					sharpProto.extract = originalExtract;
				}

				// 1) processAiJob THROWS a descriptive, NON-retryable extract failure
				//    (not a silent full-page degrade). This is the error the queue loop
				//    catches and turns into a terminal job failure.
				expect(thrown).toBeTruthy();
				expect(thrown instanceof Error).toBe(true);
				const failure = thrown as Error & { retryable?: boolean; code?: string };
				expect(failure.message).toContain("extract");
				expect(failure.retryable).toBe(false);
				expect(failure.code).toBe("crop_extract_failed");

				// 2) The crop:extract_failed event survives, records the CLAMPED requested
				//    crop, and no longer carries any full-page-degrade fields.
				const events = await jobQueue.eventsFor(jobId);
				const extractEvent = events.find((e) => e.type === "crop:extract_failed");
				expect(extractEvent).toBeTruthy();
				expect(extractEvent?.metadata?.crop).toEqual(requested);
				expect(extractEvent?.metadata).not.toHaveProperty("effectiveCrop");
				expect(extractEvent?.metadata).not.toHaveProperty("effectiveCropSwitchedToFullPage");

				// 3) Drive the thrown error through the SAME terminal-error transition the
				//    queue worker loop uses (processNext → updateFromProcessor with the
				//    normalized failure). This is the production path that releases the
				//    reservation; we invoke it directly because the unit test calls
				//    processAiJob() outside the worker loop.
				await jobQueue.updateFromProcessor(job, {
					status: "error",
					error: failure.message,
					retryable: failure.retryable,
					failureCode: failure.code,
				});

				const finished = await jobQueue.get(jobId);
				// The job is terminally FAILED — not "done", never a full-page result.
				expect(finished?.status).toBe("error");
				// job.error is allowlist-sanitized: the raw sharp text never leaks; the
				// stored value is the friendly/generic AI error string.
				expect(finished?.error).toBe(AI_PROVIDER_GENERIC_ERROR);
				expect(finished?.error).not.toContain("bad extract area");

				// 4) RESERVATION RELEASE — the codex concern. The terminal-error transition
				//    settled the reserved credit to "released" (settleCreditReservation →
				//    settleUsageLedger("released", "job_error")) and recorded the
				//    credit:released event. This is the existing reservation-release path,
				//    proving a thrown extract error refunds rather than strands the reserve.
				expect(finished?.creditReservation?.status).toBe("released");
				expect(finished?.creditReservation?.reason).toBe("job_error");
				const releaseEvent = events.concat(await jobQueue.eventsFor(jobId))
					.find((e) => e.type === "credit:released");
				expect(releaseEvent).toBeTruthy();
			},
		);
	});
});
