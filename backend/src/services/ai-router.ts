// AI Router — routes between ChatGPT (primary) and OpenRouter (fallback)
// Uses safe path resolution and proper error handling

import { loadConfig, serverConfig } from "../config.js";
import { checkpointRank, jobQueue } from "./queue.js";
import { canUseSfxProvider, isSfxDisabled, resolveSfxPinnedProvider, SFX_WORKER_PROVIDER_ID } from "./provider-controls.js";
import { resolveAiTierProviderRoute, resolveOfficialProviderCandidates } from "./provider-routing.js";
import type { OfficialProviderCandidate } from "./provider-routing.js";
import { AiProviderError, getOfficialProvider } from "./ai-providers/index.js";
import type { AiOfficialProvider, ProviderId } from "../types/index.js";
import { clampCrop, isValidProjectId, isValidImageId } from "../utils/security.js";
import { assertAssetReadyForAiAuthoritative, recordUploadedAsset, removeAssetRecordAuthoritative } from "./assets.js";
import { objectStorage } from "./storage.js";
import {
	StorageQuotaExceededError,
	releaseProjectStorageQuotaReservationBestEffort,
	reserveProjectStorageQuota,
	type StorageQuotaReservation,
} from "./storage-quota.js";
import { OpenAiImageProviderError } from "./openai-image.js";
import { resolveOpenAiImageOutputSize } from "./cost-estimator.js";
import { moderatePrompt } from "./moderation.js";
import { resolvePromptModerationWorkspaceId } from "./ai-job-submission.js";
import { ByoApiError, byoApiService, resolveWorkspaceIdForProject } from "./byo-api.js";
import { emitAiJobStatusForJob } from "./realtime-emitters.js";
import type { AiJob, AiJobCheckpoint, AppConfig } from "../types/index.js";

// Whether a provider failure should trigger failover to the NEXT candidate. Only
// transient/retryable failures (429 / 5xx / network) fall over; a deterministic
// failure (format-lock, bad request, content rejection) would fail the same way on
// every provider, so it surfaces immediately. Mirrors the queue's retry classifier.
function isRetryableProviderFailure(error: unknown): boolean {
	if (error instanceof OpenAiImageProviderError) return error.retryable;
	if (error instanceof AiProviderError) return error.retryable;
	// Unknown/transport error (fetch throw, provider returned no image): treat as
	// retryable so a flaky primary can fall over to the configured secondary.
	return true;
}

// Object-storage imageId under which an AI job's raw, PRE-MODERATION provider
// result is parked after a successful (and idempotency-sensitive) provider call.
// Persisting it lets a worker restart RESUME the job without re-calling — and
// re-charging — the provider (W4.9). Cleaned up once the job reaches a terminal
// state.
//
// SAFETY (codex P0-3): these raw bytes are UNMODERATED and live in the
// project-image keyspace under a PREDICTABLE id, but they are deliberately NOT
// registered as an asset record. The `/api/images/:projectId/:imageId` serve gate
// (`assertAssetServable`) now FAILS CLOSED on any id with no authoritative asset
// record, so this checkpoint can never be fetched by id. Only the FINAL,
// moderation-gated `result_<jobId>.png` (written via `recordUploadedAsset`, which
// runs moderation) ever gets a servable asset record. Do NOT register this
// checkpoint as an asset or move it onto a servable code path.
export function providerCheckpointImageId(jobId: string): string {
	return `aijob_provider_${jobId}.png`;
}

export async function cleanupProviderCheckpointArtifact(projectId: string, jobId: string): Promise<void> {
	try {
		await objectStorage.deleteProjectImage({ projectId, imageId: providerCheckpointImageId(jobId) });
	} catch (error) {
		console.warn(`[AI] Job ${jobId}: failed to clean up provider checkpoint artifact`, error);
	}
}

/**
 * Wire the AI router's provider-checkpoint reaper to the queue's cancel path.
 * When a job becomes terminally `cancelled`, the parked provider checkpoint
 * (`aijob_provider_<jobId>.png`) that the in-flight finalize catch preserves for
 * a (never-arriving) reclaiming worker would otherwise accrue storage forever.
 * This hook deletes it — idempotent (no-op if already gone) and best-effort
 * (errors swallowed/logged), so cancellation always succeeds. Safe to call more
 * than once; only the first registration per queue takes effect.
 */
let aiCancelCleanupRegistered = false;
export function registerAiJobCancelCleanup(queue: { onCancelCleanup: (fn: (job: { projectId: string; jobId: string }) => Promise<void> | void) => void }): void {
	if (aiCancelCleanupRegistered) return;
	aiCancelCleanupRegistered = true;
	queue.onCancelCleanup(async (job) => {
		await cleanupProviderCheckpointArtifact(job.projectId, job.jobId);
	});
}

// Tagged error for "this processor no longer holds the job's lease" (the job was
// reclaimed by another worker — e.g. after a lease-recovery or shutdown drain).
// The W4.9 finalize catch block uses the tag to AVOID deleting the parked
// provider checkpoint artifact: the replacement processor needs it to resume
// without re-calling the provider.
type LeaseLostError = Error & { leaseLost?: true };
function leaseLostError(jobId: string): LeaseLostError {
	const error = new Error(`AI job ${jobId} processor lease is no longer active`) as LeaseLostError;
	error.leaseLost = true;
	return error;
}
function isLeaseLostError(error: unknown): boolean {
	return Boolean((error as LeaseLostError | undefined)?.leaseLost);
}

async function assertActiveProcessor(job: AiJob): Promise<void> {
	if (await jobQueue.assertActiveProcessor(job)) return;
	throw leaseLostError(job.jobId);
}

async function updateActiveProcessor(job: AiJob, update: Partial<AiJob>): Promise<void> {
	if (await jobQueue.updateFromProcessor(job, update)) return;
	if (await jobQueue.assertActiveProcessor(job)) return;
	throw leaseLostError(job.jobId);
}

/** True if a decodable raster image (used to validate checkpoint artifacts). */
async function isDecodableImage(buffer: Buffer): Promise<boolean> {
	try {
		const sharp = (await import("sharp")).default;
		const metadata = await sharp(buffer).metadata();
		return Boolean(metadata.width && metadata.height);
	} catch {
		return false;
	}
}

// W4.7 — DORMANT legacy path. This drives the reverse-engineered Python scraper
// worker, which has NO vendor SLA and breakage/ToS risk. It is kept present but
// is only ever reached when config.aiPythonEnabled (env AI_PYTHON_ENABLED) is
// explicitly true — default FALSE in every environment, prod especially. The
// official-API providers (OpenAI/OpenRouter, see services/ai-providers/) are the
// default SLA path. This function double-checks the gate as defense-in-depth so
// it cannot run even if a future caller forgets the provider-availability filter.
async function callPythonWorker(imageBuffer: Buffer, prompt: string, config: AppConfig): Promise<Buffer> {
  if (!config.aiPythonEnabled) {
    throw new Error("Python AI worker is disabled (AI_PYTHON_ENABLED is off). AI jobs route to official providers.");
  }
  const base64 = imageBuffer.toString("base64");
  const response = await fetch(`${serverConfig.workerUrl}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_base64: base64, prompt, model: "gpt-5.5" }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Worker error ${response.status}: ${text}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("image/")) {
    return Buffer.from(await response.arrayBuffer());
  }
  const data = (await response.json()) as { text?: string };
  throw new Error(`Worker returned text instead of image: ${(data.text || "").substring(0, 200)}`);
}

export async function processAiJob(job: AiJob): Promise<void> {
	const config = loadConfig();
	const { projectId, imageId, crop, prompt } = job;
	const tier = job.tier ?? "sfx-pro";

	// W4.9 in-flight continuity: how far a previous (interrupted) run got. A
	// worker restart re-claims this job and re-enters processAiJob; the checkpoint
	// rank lets us skip steps that already completed so we never re-run prompt
	// moderation or — critically — re-call/re-charge the provider.
	const resumeRank = checkpointRank(job.checkpoint?.step);
	const isResume = resumeRank > 0;
	if (isResume) {
		await jobQueue.recordEvent(job.jobId, "checkpoint:resume", "Resuming interrupted AI job from checkpoint", {
			step: job.checkpoint?.step,
			providerResultImageId: job.checkpoint?.providerResultImageId,
		});
	}

	// Advance the durable checkpoint for this job (lease-guarded inside the queue).
	const checkpoint = async (next: Omit<AiJobCheckpoint, "updatedAt">): Promise<void> => {
		await jobQueue.recordCheckpoint(job, { ...next, updatedAt: Date.now() });
	};

	// Validate IDs
	if (!isValidProjectId(projectId) || !isValidImageId(imageId)) {
		throw new Error(`Invalid project/image ID in job ${job.jobId}`);
	}

	// W4.9 idempotent resume — `output_stored`: a prior run already composited the
	// output, reserved+released its storage quota, and registered it in the asset
	// registry under `result_${jobId}.png`. Resuming past this checkpoint must NOT
	// re-composite, re-reserve storage quota, or re-record the asset: the stored
	// output already counts as used bytes, so a re-reservation could spuriously
	// fail storage-quota validation for an output that is already durably stored.
	// Skip straight to the (idempotent) `done` finalization.
	if (resumeRank >= checkpointRank("output_stored")) {
		const resultId = `result_${job.jobId}.png`;
		const stored = await objectStorage.getProjectImage({ projectId, imageId: resultId });
		if (stored && (await isDecodableImage(stored))) {
			await emitAiJobStatusForJob({ ...job, status: "processing" }).catch(() => {/* swallow */});
			await jobQueue.recordEvent(job.jobId, "checkpoint:output_reused", "Reused checkpointed stored output; skipped composite/storage on resume", {
				resultImageId: resultId,
				resultBytes: stored.length,
			});
			await updateActiveProcessor(job, {
				status: "done",
				resultImageId: resultId,
				// Carry through the routing resolved on the original run (codex P1 #4):
				// the provider was checkpointed; the model (if any) is already on the job.
				resolvedProvider: job.resolvedProvider ?? job.checkpoint?.provider,
				resolvedModel: job.resolvedModel,
			});
			// The published output is the source of truth; drop the parked provider
			// artifact (best-effort).
			await cleanupProviderCheckpointArtifact(projectId, job.jobId);
			await emitAiJobStatusForJob({ ...job, status: "done", resultImageId: resultId }).catch(() => {/* swallow */});
			console.log(`[AI] Job ${job.jobId}: Resumed at output_stored. Finalized ${resultId} (${stored.length} bytes)`);
			return;
		}
		// Stored output is missing/corrupt despite the checkpoint (rare: side-write
		// lost). Fall through to a full re-run; the provider-result reuse guard
		// below still avoids a second billed provider call when its parked artifact
		// is intact, and storage re-reservation for a no-longer-present output is
		// correct here.
		await jobQueue.recordEvent(job.jobId, "checkpoint:output_missing", "Checkpointed stored output unavailable/corrupt; re-running finalize on resume", {
			resultImageId: resultId,
			storedBytes: stored?.length,
		});
	}

	// W2.7 Realtime: announce that the job has entered the processing phase so
	// SSE subscribers can flip their UI to "running". Best-effort; failures
	// here must not block the job.
	await emitAiJobStatusForJob({ ...job, status: "processing" }).catch(() => {/* swallow */});

	try {
		await assertAssetReadyForAiAuthoritative(projectId, imageId, {
			requireRegistry: serverConfig.aiRequireAssetRegistryForAi,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Asset is not ready for AI";
		await jobQueue.recordEvent(job.jobId, "asset:not_ready", "Source asset is not ready for AI processing", {
			imageId,
			error: message,
		});
		const blocked = new Error(message) as Error & { retryable?: boolean; code?: string };
		blocked.retryable = false;
		blocked.code = "asset_not_ready";
		throw blocked;
	}

	// Skip prompt moderation on resume if a prior run already cleared it. Re-running
	// is safe (free, deterministic) but pointless, and skipping keeps a resume from
	// flipping a previously-passed prompt to needs_review on a ruleset change mid-job.
	if (config.promptModerationEnabled && resumeRank < checkpointRank("moderated")) {
		const moderationWorkspaceId = await resolvePromptModerationWorkspaceId(projectId);
		const moderation = await moderatePrompt(prompt, moderationWorkspaceId);
		if (moderation.decision === "block") {
			await jobQueue.recordEvent(job.jobId, "moderation:blocked", "Prompt blocked before provider dispatch", {
				reason: moderation.reason,
				status: moderation.status,
				rulesetVersion: moderation.ruleset_version,
			});
			const blocked = new Error("Prompt blocked by moderation") as Error & { retryable?: boolean; code?: string };
			blocked.retryable = false;
			blocked.code = moderation.status === "csam_block" ? "csam_block" : "moderation_blocked";
			throw blocked;
		}
		if (moderation.decision === "warn") {
			// A `warn` at processing time means the prompt needs review before any
			// provider dispatch — e.g. the job was queued before prompt moderation was
			// enabled, or before a threshold/BYO-policy change flipped this prompt to a
			// soft hit. Park the job in `needs_review` (which the queue settles by
			// releasing the reserved credit) instead of sending the prompt downstream.
			await jobQueue.recordEvent(job.jobId, "moderation:needs_review", "Prompt moderation warning parked job for review before provider dispatch", {
				reason: moderation.reason,
				status: moderation.status,
				rulesetVersion: moderation.ruleset_version,
			});
			await updateActiveProcessor(job, { status: "needs_review" });
			return;
		}
	}

	// Checkpoint: prompt moderation has cleared (or was disabled / already cleared
	// on a prior run). A restart after this point skips moderation re-dispatch.
	if (resumeRank < checkpointRank("moderated")) {
		await checkpoint({ step: "moderated" });
	}

	// W4.7: every implemented tier route resolves to an OFFICIAL-API adapter
	// (openai-image / openrouter-image) — the default SLA path. The legacy SFX
	// fallback loop below can only reach the Python worker when AI_PYTHON_ENABLED
	// is explicitly on (provider-controls.canUseSfxProvider gates it), so in
	// production AI jobs run on official providers only. See services/ai-providers.
	const route = resolveAiTierProviderRoute(tier);
	if (!route.implemented) {
		await updateActiveProcessor(job, { provider: route.providerHint });
		await jobQueue.recordEvent(job.jobId, "provider:adapter_pending", `${route.label} provider adapter is not implemented yet`, {
			tier,
			providerHint: route.providerHint,
		});
		throw new Error(`${route.label} provider adapter (${route.providerHint}) is not implemented yet. Use SFX Pro or enable the clean provider adapter before processing this tier.`);
	}

	const imageBuf = await objectStorage.getProjectImage({ projectId, imageId });
	if (!imageBuf) {
		throw new Error(`Image ${imageId} not found for project ${projectId}`);
	}

	// Get image dimensions for crop clamping
	const sharp = await import("sharp");
	const metadata = await sharp.default(imageBuf).metadata();
	const maxW = metadata.width || 9999;
	const maxH = metadata.height || 9999;
	// The clamped, in-bounds crop rect the WHOLE pipeline (provider output sizing,
	// compositing, asset provenance) operates on. `const`: it is never reassigned.
	const safeCrop = clampCrop(crop, maxW, maxH);

	// Crop image. clampCrop now guarantees an in-bounds extract region, so a
	// sharp.extract throw here is NOT an out-of-bounds geometry bug — it means a
	// genuinely broken input (corrupt image / decoder error). We FAIL the job
	// cleanly instead of widening to the full page, because widening is wrong on
	// two axes that the terminal-failure path gets right (codex round-2):
	//   1. BILLING — cost / reservation / admission were computed for the SMALL
	//      requested crop. Feeding the FULL page to the provider would undercharge
	//      and bypass the per-project reserved-credit cap on tall webtoons.
	//   2. MARKER GEOMETRY — the AI review marker's region stays the small rect, so
	//      a full-page result would be placed/applied into the small region by the
	//      frontend (wrong geometry / distorted output).
	// Throwing here lands in the queue's terminal-error transition
	// (processNext → updateFromProcessor({ status: "error" }) → applyJobUpdate →
	// settleCreditReservation releases the reservation + releaseSharedCreditsBestEffort
	// refunds the credit buckets), so the reserved credit is released — exactly the
	// right outcome for a broken-input failure.
	let croppedBuf: Buffer;
	try {
		croppedBuf = await sharp.default(imageBuf)
			.extract({ left: safeCrop.x, top: safeCrop.y, width: safeCrop.w, height: safeCrop.h })
			.png()
			.toBuffer();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[AI] Job ${job.jobId}: crop extraction failed on an in-bounds region (broken input); failing job: ${message}`);
		await jobQueue.recordEvent(job.jobId, "crop:extract_failed", "Crop extraction failed on an in-bounds region; failing job", {
			crop: safeCrop,
			maxW,
			maxH,
			error: message,
		});
		// Surface a descriptive, NON-retryable error. The standard error idiom in
		// this file: throw an Error with `retryable`/`code` so normalizeProcessorFailure
		// records the failure code and never re-runs a deterministically broken input.
		// job.error is allowlist-sanitized at the persist layer (updateFromProcessor →
		// sanitizeOptionalAiError) before it is stored/served, so the raw sharp text
		// never leaks; the friendly/generic string is what the client sees.
		const extractFailed = new Error(
			`Failed to extract the requested crop region from the source image (the image may be corrupt or unreadable): ${message}`,
		) as Error & { retryable?: boolean; code?: string };
		extractFailed.retryable = false;
		extractFailed.code = "crop_extract_failed";
		throw extractFailed;
	}

	let resultBuf: Buffer | undefined;
	let reusedProviderResult = false;
	// The ProviderId actually dispatched to (BYO / official OpenAI / OpenRouter /
	// legacy SFX). Recorded in the provider_succeeded checkpoint so a resume reuses
	// and reports the real provider, not the static tier hint (W4.7 official routing
	// can resolve OpenRouter when AI_DEFAULT_PROVIDER is pinned there).
	let dispatchedProviderId: ProviderId = route.providerHint;
	// The model id the successful provider actually used. Persisted on the job
	// (resolvedModel) so routing is server-owned + auditable (codex P1 #4).
	let dispatchedModel: string | undefined;
	// When a `provider_succeeded` (or later) resume cannot trust its parked
	// artifact (missing/corrupt) and falls through to re-call the provider, the
	// fresh result must be re-parked + re-checkpointed even though `resumeRank` is
	// already at/after `provider_succeeded`. Otherwise the checkpoint keeps
	// pointing at the bad artifact and a further restart re-calls the provider
	// again (W4.9 idempotency hole).
	let mustReparkProviderResult = false;
	// W4.9 idempotent resume: if a prior run already obtained a provider image and
	// checkpointed it, reuse the parked artifact instead of calling the provider
	// again. This is the single most important idempotency guard — it prevents a
	// restart mid-job from issuing a second (billed) provider request.
	if (resumeRank >= checkpointRank("provider_succeeded")) {
		const parkedId = job.checkpoint?.providerResultImageId ?? providerCheckpointImageId(job.jobId);
		const parked = await objectStorage.getProjectImage({ projectId, imageId: parkedId });
		// Validate the artifact is a DECODABLE image, not merely large enough. A
		// partial/corrupt object above the size floor would otherwise skip the
		// provider call, then fail later at composite/recordUploadedAsset — turning
		// a recoverable checkpoint corruption into a terminal job error.
		const decodable = parked && parked.length >= 1000 ? await isDecodableImage(parked) : false;
		if (parked && decodable) {
			resultBuf = parked;
			reusedProviderResult = true;
			if (job.checkpoint?.provider) job.provider = job.checkpoint.provider;
			await jobQueue.recordEvent(job.jobId, "checkpoint:provider_reused", "Reused checkpointed provider result; skipped provider call on resume", {
				providerResultImageId: parkedId,
				provider: job.checkpoint?.provider,
				resultBytes: parked.length,
			});
		} else {
			// Artifact missing/corrupt (e.g. checkpoint advanced but the side-write
			// never durably landed before the crash, or only partial bytes flushed).
			// Fall through to a normal provider call — the credit capture only happens
			// at the `done` transition, so re-calling here does not double-charge the
			// customer — and flag that the fresh result must be re-parked so the
			// checkpoint stops pointing at the bad artifact.
			mustReparkProviderResult = true;
			await jobQueue.recordEvent(job.jobId, "checkpoint:provider_artifact_missing", "Checkpointed provider artifact unavailable/corrupt; re-running provider on resume", {
				providerResultImageId: parkedId,
				parkedBytes: parked?.length,
				decodable,
			});
		}
	}
	const workspaceId = await resolveWorkspaceIdForProject(projectId);
	const byoProvider = workspaceId ? await byoApiService.getWorkspaceByoProvider(workspaceId) : null;
	// A job admitted on the BYO path carried no credit reservation AND skipped
	// platform prompt moderation, on the promise that the workspace's own provider
	// key would handle it. If the key/add-on was removed between submission and
	// processing, byoProvider is now null. We must NOT silently fall back to a
	// platform provider here — that would consume platform OpenAI/OpenRouter with
	// no credit capture and no prior prompt moderation for this job. Fail it so the
	// client can resubmit (which re-runs moderation + credit reservation) or
	// reconfigure BYO.
	// `!resultBuf` so a resume that already has a checkpointed provider result is
	// not failed by a BYO key that was revoked AFTER the provider already ran.
	if (!resultBuf && job.byoQueued && !(workspaceId && byoProvider)) {
		await jobQueue.recordEvent(job.jobId, "byo:route_revoked", "BYO key/add-on was removed before processing; refusing platform fallback for a BYO-queued job", {
			workspaceId,
			hadByoProvider: Boolean(byoProvider),
		});
		const revoked = new Error(
			"This job was queued to run on the workspace's own API key, but that BYO key or add-on is no longer active. Resubmit the request to run it on platform credits (with prompt moderation) or restore the BYO key.",
		) as Error & { retryable?: boolean; code?: string };
		revoked.retryable = false;
		revoked.code = "byo_route_revoked";
		throw revoked;
	}
	// Route through BYO ONLY for jobs admitted on the BYO path. A platform-admitted
	// job (which reserved workspace credits and passed prompt moderation) must keep
	// running on the platform provider even if a BYO key was added after it was
	// queued — otherwise its reserved credits would be stranded while the request
	// quietly used the customer key.
	if (!resultBuf && job.byoQueued && workspaceId && byoProvider) {
		const providerId = `byo-${byoProvider}` as const;
		const model = byoApiService.modelsForTask(byoProvider, "image")[0]!;
		await updateActiveProcessor(job, { provider: providerId });
		await jobQueue.recordEvent(job.jobId, "byo:attempt", "Trying workspace BYO API key", {
			workspaceId,
			provider: byoProvider,
			model,
			taskType: "image",
			policyModerationBypassed: true,
			csamModerationRequired: true,
		});
		try {
			const result = await byoApiService.routeAIRequest({
				workspaceId,
				provider: byoProvider,
				taskType: "image",
				model,
				imageBuffer: croppedBuf,
				prompt,
				mimeType: "image/png",
				filename: "crop.png",
				quality: job.quality ?? config.openaiImageDefaultQuality,
				size: resolveOpenAiImageOutputSize(safeCrop),
			});
			if (!result.buffer) throw new Error("BYO provider did not return an image");
			resultBuf = result.buffer;
			dispatchedProviderId = providerId;
			dispatchedModel = result.model;
			await jobQueue.recordEvent(job.jobId, "byo:success", "Workspace BYO provider returned an image", {
				workspaceId,
				provider: byoProvider,
				model: result.model,
				resultBytes: resultBuf.length,
				usage: result.usage,
			});
		} catch (error) {
			// HONEST BYO failure (codex P1 #5): there is NO automatic server-side switch
			// to platform credits. A BYO-queued job carries no credit reservation and
			// skipped platform prompt moderation, and the queue's retry of a byoQueued job
			// stays on the BYO path (queue.ts derives no reservation for byoQueued retries).
			// So a queue retry would only re-run the SAME failing BYO key — never a credit
			// run. The real switch-to-credits is CLIENT-driven: resubmit WITHOUT the BYO
			// route, which lands in the platform idempotency namespace (the `byo` marker in
			// resolveAiSubmitIdempotency) and creates a fresh moderated, credit-reserved
			// platform job. We therefore fail this job NON-retryably with an actionable
			// message instead of silently retrying BYO (or claiming a switch that never
			// happens). No double-charge: BYO reserved nothing; the client's platform
			// resubmit reserves + moderates exactly once under its own jobId.
			await jobQueue.recordEvent(job.jobId, "byo:failure", "Workspace BYO provider failed; resubmit on platform credits to switch (no automatic server-side switch)", {
				workspaceId,
				provider: byoProvider,
				model,
				error: error instanceof Error ? error.message : String(error),
				code: error instanceof ByoApiError ? error.code : undefined,
				switchToCredits: "client_resubmit_on_platform_credits",
			});
			if (error instanceof ByoApiError) {
				const failed = new Error(
					error.code === "byo_provider_failed_switch_to_credits"
						? "The workspace's own API key failed for this request. Resubmit on platform credits (which re-runs prompt moderation and reserves credits) to retry."
						: error.message,
				) as Error & { retryable?: boolean; code?: string };
				// Non-retryable: a queue retry would re-run the SAME failing BYO key with no
				// credit reservation. The switch is the client's platform resubmit.
				failed.retryable = false;
				failed.code = error.code;
				throw failed;
			}
			throw error;
		}
	}

	// W4.7: platform official-provider dispatch. For any tier whose route is an
	// official-API adapter, the ACTUAL provider is resolved from config via
	// resolveOfficialProvider(config) so the operator-selected AI_DEFAULT_PROVIDER
	// (OpenAI by default, OpenRouter when pinned) is honored in production jobs —
	// not just in tests/importers. We dispatch through the provider adapter's
	// run(), which enforces the model FORMAT LOCK: a misconfigured OPENAI_IMAGE_MODEL
	// (e.g. a text model) now fails fast with `ai_provider_format_lock` instead of
	// reaching the network. The Python worker is never selected here.
	if (!resultBuf && (route.adapter === "openai-image" || route.adapter === "openrouter-image")) {
		const openAiOutputSize = resolveOpenAiImageOutputSize(safeCrop);
		const quality = job.quality ?? config.openaiImageDefaultQuality;

		// One official-provider attempt. Dispatches through the adapter's run() (which
		// enforces the model FORMAT LOCK before any network call) and, on success,
		// records the resolved provider/model so the rest of the job reuses + persists
		// the REAL routing, not the static tier hint.
		const attemptOfficial = async (officialId: AiOfficialProvider, providerId: ProviderId): Promise<void> => {
			const officialProvider = getOfficialProvider(officialId);
			// For OpenAI, pass the configured image model so the format lock validates
			// it before the network call. For OpenRouter, let the adapter pick its
			// format-locked default (the tier's OpenAI model ids are not valid here).
			const requestModel = officialId === "openai" ? config.openaiImageModel : undefined;
			console.log(`[AI] Job ${job.jobId}: Using ${officialId} (${tier}, ${quality})`);
			await updateActiveProcessor(job, { provider: providerId });
			await jobQueue.recordEvent(job.jobId, "provider:attempt", "Trying AI provider", {
				provider: providerId,
				tier,
				model: requestModel,
				quality,
				size: openAiOutputSize,
			});
			try {
				const result = await officialProvider.run({
					taskType: "image",
					imageBuffer: croppedBuf,
					prompt,
					mimeType: "image/png",
					filename: "crop.png",
					model: requestModel,
					apiKey: officialId === "openrouter" ? config.openrouterApiKey : undefined,
					quality,
					size: openAiOutputSize,
					user: job.projectId,
				});
				if (!result.buffer) {
					throw new Error(`${officialId} provider did not return an image`);
				}
				resultBuf = result.buffer;
				dispatchedProviderId = providerId;
				dispatchedModel = result.model;
				await jobQueue.recordEvent(job.jobId, "provider:success", "AI provider returned an image", {
					provider: providerId,
					tier,
					model: result.model,
					resultBytes: result.buffer.length,
					requestMs: result.requestMs,
					size: openAiOutputSize,
					usage: result.usage,
				});
			} catch (error) {
				await jobQueue.recordEvent(job.jobId, "provider:failure", "AI provider failed", {
					provider: providerId,
					tier,
					model: requestModel,
					error: error instanceof Error ? error.message : String(error),
					statusCode: error instanceof OpenAiImageProviderError ? error.statusCode : undefined,
					providerCode:
						error instanceof OpenAiImageProviderError
							? error.code
							: error instanceof AiProviderError
								? error.code
								: undefined,
					providerType: error instanceof OpenAiImageProviderError ? error.providerType : undefined,
					retryable:
						error instanceof OpenAiImageProviderError
							? error.retryable
							: error instanceof AiProviderError
								? error.retryable
								: undefined,
					retryAfterSeconds: error instanceof OpenAiImageProviderError ? error.retryAfterSeconds : undefined,
				});
				throw error;
			}
		};

		type Attempt = { providerId: ProviderId; run: () => Promise<void> };
		const runPythonWorker = (providerId: ProviderId): Attempt => ({
			providerId,
			run: async () => {
				console.log(`[AI] Job ${job.jobId}: Using Python worker (${tier})`);
				await updateActiveProcessor(job, { provider: providerId });
				await jobQueue.recordEvent(job.jobId, "provider:attempt", "Trying AI provider", { provider: providerId, tier });
				try {
					const buffer = await callPythonWorker(croppedBuf, prompt, config);
					resultBuf = buffer;
					dispatchedProviderId = providerId;
					dispatchedModel = "gpt-5.5";
					await jobQueue.recordEvent(job.jobId, "provider:success", "AI provider returned an image", {
						provider: providerId,
						tier,
						resultBytes: buffer.length,
					});
				} catch (error) {
					await jobQueue.recordEvent(job.jobId, "provider:failure", "AI provider failed", {
						provider: providerId,
						tier,
						error: error instanceof Error ? error.message : String(error),
					});
					throw error;
				}
			},
		});

		// Ordered provider-candidate list. The BASE order is the official-default
		// candidates (aiDefaultProvider first, the other configured+non-killed official
		// provider as failover). For an SFX-controlled tier (sfx-pro) the SFX controls
		// GATE this: `disabled` blocks the tier outright, and an explicit pin
		// (python-worker / gpt-5.4-image-2→OpenRouter) restricts the candidates — while
		// the legacy default (`openai-gpt-image-2`) and `auto` defer to the
		// official-default order so AI_DEFAULT_PROVIDER still wins for SFX. Per-provider
		// kill switches drop a candidate (handled in resolveOfficialProviderCandidates).
		// Failover only happens on a RETRYABLE failure; a deterministic failure
		// (format-lock, bad request) surfaces immediately.
		const attempts: Attempt[] = [];
		if (route.sfxControlled && isSfxDisabled(config)) {
			throw new Error(`${route.label} is disabled by the SFX provider mode.`);
		}
		const sfxPin = route.sfxControlled ? resolveSfxPinnedProvider(config) : null;
		if (sfxPin === SFX_WORKER_PROVIDER_ID) {
			// Operator pinned the legacy Python worker (only usable when AI_PYTHON_ENABLED).
			if (!canUseSfxProvider(config, SFX_WORKER_PROVIDER_ID)) {
				throw new Error(`${route.label} is pinned to the Python worker, which is not available (AI_PYTHON_ENABLED off or killed).`);
			}
			attempts.push(runPythonWorker(SFX_WORKER_PROVIDER_ID));
		} else {
			let candidates: OfficialProviderCandidate[] = resolveOfficialProviderCandidates(config).filter((c) => c.available);
			// An explicit OpenRouter SFX pin restricts the candidates to OpenRouter only.
			if (sfxPin === "openrouter-gpt-5.4-image-2") {
				candidates = candidates.filter((c) => c.officialId === "openrouter");
			}
			for (const candidate of candidates) {
				const officialId = candidate.officialId;
				attempts.push({ providerId: candidate.providerId, run: () => attemptOfficial(officialId, candidate.providerId) });
			}
		}

		if (attempts.length === 0) {
			throw new Error(`${route.label} provider is not available. Check provider kill switches and API config.`);
		}

		let lastError: unknown;
		for (let i = 0; i < attempts.length; i++) {
			const attempt = attempts[i]!;
			try {
				await attempt.run();
				lastError = undefined;
				break;
			} catch (error) {
				lastError = error;
				const hasNext = i < attempts.length - 1;
				// Only fall over to the next candidate on a retryable (transient) failure.
				// A deterministic failure would fail identically on every provider, so
				// surface it now rather than masking it behind a second billed call.
				if (!hasNext || !isRetryableProviderFailure(error)) throw error;
				await jobQueue.recordEvent(job.jobId, "provider:fallback", "Primary AI provider failed; falling back to next configured provider", {
					failedProvider: attempt.providerId,
					nextProvider: attempts[i + 1]!.providerId,
					tier,
					error: error instanceof Error ? error.message : String(error),
				});
				console.log(`[AI] Job ${job.jobId}: Provider ${attempt.providerId} failed (retryable); falling back to ${attempts[i + 1]!.providerId}`);
			}
		}
		if (lastError) throw lastError;
	}

	if (!resultBuf) {
		throw new Error(`${route.label} provider finished without returning an image`);
	}

	// Validate result
	if (!resultBuf || resultBuf.length < 1000) {
		throw new Error("AI returned invalid image (too small)");
	}

	// W4.9: park the freshly-obtained provider result and checkpoint it BEFORE the
	// (also-restartable) compositing/storage steps run. If the worker dies after
	// this point, the resume reuses this artifact and never re-calls the provider.
	// Skipped when we already reused a checkpointed result on this very resume.
	// `mustReparkProviderResult` covers the recovery case where this run was
	// already at/after `provider_succeeded` but its parked artifact was
	// missing/corrupt: we re-called the provider above, so we must overwrite the
	// bad artifact and re-checkpoint it (re-pointing providerResultImageId at the
	// fresh bytes) — otherwise a further restart repeats the missing-artifact path
	// and issues yet another billed provider call.
	if (!reusedProviderResult && (mustReparkProviderResult || resumeRank < checkpointRank("provider_succeeded"))) {
		const parkedId = providerCheckpointImageId(job.jobId);
		await assertActiveProcessor(job);
		await objectStorage.putProjectImage({ projectId, imageId: parkedId, buffer: resultBuf });
		await checkpoint({ step: "provider_succeeded", providerResultImageId: parkedId, provider: dispatchedProviderId });
	}

	// Composite AI result onto original image at crop position
	let finalBuf: Buffer;
	try {
		const sharp = (await import("sharp")).default;
		const resizedResult = await sharp(resultBuf)
			.resize(safeCrop.w, safeCrop.h, { fit: "fill" })
			.png()
			.toBuffer();
		finalBuf = await sharp(imageBuf)
			.composite([{
				input: resizedResult,
				left: safeCrop.x,
				top: safeCrop.y,
			}])
			.png()
			.toBuffer();
		console.log(`[AI] Composited result onto original at (${safeCrop.x},${safeCrop.y}) ${safeCrop.w}x${safeCrop.h}`);
	} catch (e) {
		console.log(`[AI] Composite failed, using raw result: ${e}`);
		finalBuf = resultBuf;
	}

	// Save final composited image through the storage/asset pipeline so AI output
	// is quota-counted and future R2 writes keep the same boundary.
	const resultId = `result_${job.jobId}.png`;
	await assertActiveProcessor(job);
	let storageReservation: StorageQuotaReservation | undefined;
	try {
		const result = await reserveProjectStorageQuota({
			projectId,
			bytes: finalBuf.byteLength,
			reason: "ai_output",
			metadata: {
				jobId: job.jobId,
				imageId: resultId,
			},
		});
		storageReservation = result.reservation;
	} catch (error) {
		if (error instanceof StorageQuotaExceededError) {
			await jobQueue.recordEvent(job.jobId, "storage:quota_rejected", "AI output rejected by workspace storage quota", {
				attemptedBytes: error.attemptedBytes,
				remainingBytes: error.summary.remainingBytes,
				limitBytes: error.summary.limitBytes,
			});
			throw new Error(`Storage quota exceeded for AI output (${finalBuf.byteLength} bytes)`);
		}
		throw error;
	}
	let imageStored = false;
	let assetRecorded = false;
	let reservationReleased = false;
	if (!storageReservation) {
		throw new Error("AI output storage quota reservation was not created");
	}
	try {
		await assertActiveProcessor(job);
		const storedObject = await objectStorage.putProjectImage({ projectId, imageId: resultId, buffer: finalBuf });
		imageStored = true;
		await assertActiveProcessor(job);
		const asset = await recordUploadedAsset({
			projectId,
			imageId: resultId,
			originalName: resultId,
			imageBuffer: finalBuf,
			storedObject,
			mimeType: "image/png",
			sizeBytes: finalBuf.byteLength,
			uploadedBy: {
				source: "ai_job",
				userId: job.projectId,
			},
			// Provenance for the asset-library: the machine `kind` (asset_records.kind)
			// stays "ai_job" via uploadedBy.source — that is the column the library
			// filters AI output on. This metadata adds the human-facing
			// `assetKind: "ai-generated"` plus enough provenance (source image, job,
			// crop region, provider, tier) for the library to display/trace where a
			// generated asset came from. (project / bytes / createdAt already live on
			// the AssetRecord.) Persisted to the asset_records.metadata JSONB and the
			// upload-audit row.
			metadata: {
				storageReservationId: storageReservation.reservationId,
				assetKind: "ai-generated",
				ai: {
					jobId: job.jobId,
					sourceImageId: imageId,
					provider: dispatchedProviderId,
					tier,
					crop: { x: safeCrop.x, y: safeCrop.y, w: safeCrop.w, h: safeCrop.h },
				},
			},
		});
		assetRecorded = true;
		if (asset.moderation.status !== "passed") {
			await jobQueue.recordEvent(job.jobId, "asset:moderation_blocked", "AI output failed output moderation and will not be published", {
				imageId: resultId,
				assetId: asset.assetId,
				moderationStatus: asset.moderation.status,
				reason: asset.moderation.reason,
			});
			const blocked = new Error("AI output blocked by moderation") as Error & { retryable?: boolean; code?: string };
			blocked.retryable = false;
			blocked.code = asset.moderation.status === "blocked" ? "moderation_blocked" : "moderation_needs_review";
			throw blocked;
		}
		await assertActiveProcessor(job);
		const releaseResult = await releaseProjectStorageQuotaReservationBestEffort(projectId, storageReservation.reservationId, {
			reason: "ai_output",
			phase: "after_commit",
			jobId: job.jobId,
		});
		reservationReleased = !releaseResult.error;
		if (releaseResult.error) {
			try {
				await jobQueue.recordEvent(job.jobId, "storage:reservation_release_pending", "AI output storage quota reservation cleanup is pending", {
					reservationId: storageReservation.reservationId,
					error: releaseResult.error,
				});
			} catch (error) {
				console.warn(`[AI] Job ${job.jobId}: failed to record storage reservation release warning`, error);
			}
		}
		await assertActiveProcessor(job);
		await jobQueue.recordEvent(job.jobId, "asset:recorded", "AI output stored in asset registry", {
			imageId: resultId,
			assetId: asset.assetId,
			bytes: finalBuf.byteLength,
			storageDriver: asset.storageDriver,
			moderationStatus: asset.moderation.status,
		});

		// Checkpoint: the published output is durably stored + registered. A restart
		// after this point resumes here and only needs to (idempotently) finalize.
		if (resumeRank < checkpointRank("output_stored")) {
			await checkpoint({
				step: "output_stored",
				providerResultImageId: job.checkpoint?.providerResultImageId ?? providerCheckpointImageId(job.jobId),
				provider: job.checkpoint?.provider ?? dispatchedProviderId,
			});
		}

		await updateActiveProcessor(job, {
			status: "done",
			resultImageId: resultId,
			// Persist the server-resolved routing (codex P1 #4): the ProviderId actually
			// dispatched to and the model the adapter used. On a resume that reused a
			// checkpointed provider result, dispatchedModel is unset — keep whatever was
			// persisted on a prior run.
			resolvedProvider: dispatchedProviderId,
			resolvedModel: dispatchedModel ?? job.resolvedModel,
		});
		// The published output is the source of truth now; drop the parked provider
		// artifact so it does not linger (best-effort).
		await cleanupProviderCheckpointArtifact(projectId, job.jobId);
		// W2.7 Realtime: SSE subscribers transition the job card into the
		// "done" state and trigger the result-image fetch.
		await emitAiJobStatusForJob({ ...job, status: "done", resultImageId: resultId }).catch(() => {/* swallow */});
	} catch (error) {
		// Lease lost: this run was superseded (the job is now pending/processing on
		// another worker after a lease-recovery or shutdown drain). It is NOT a
		// terminal failure of the job — so we must NOT emit an `error` status, and we
		// must NOT delete state the replacement processor will reuse. In particular,
		// the parked provider checkpoint artifact must survive so the replacement can
		// resume from `provider_succeeded` without re-calling (re-charging) the
		// provider. We only release THIS run's own (now-orphaned) storage reservation.
		if (isLeaseLostError(error)) {
			if (!reservationReleased) {
				await releaseProjectStorageQuotaReservationBestEffort(projectId, storageReservation.reservationId, {
					reason: "ai_output",
					phase: "rollback",
					jobId: job.jobId,
				});
			}
			console.warn(`[AI] Job ${job.jobId}: lost processor lease during finalize; leaving checkpoint artifacts for the reclaiming worker`);
			throw error;
		}
		await emitAiJobStatusForJob({
			...job,
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		}).catch(() => {/* swallow */});
		if (!reservationReleased) {
			await releaseProjectStorageQuotaReservationBestEffort(projectId, storageReservation.reservationId, {
				reason: "ai_output",
				phase: "rollback",
				jobId: job.jobId,
			});
		}
		if (assetRecorded) await removeAssetRecordAuthoritative(projectId, resultId);
		if (imageStored) {
			try {
				await objectStorage.deleteProjectImage({ projectId, imageId: resultId });
			} catch (cleanupError) {
				console.warn(`[AI] Job ${job.jobId}: failed to clean up cancelled AI output ${resultId}`, cleanupError);
			}
		}
		// A failure in the storage/finalize stage is terminal for THIS job (a retry
		// is a brand-new jobId with no checkpoint), so the parked provider artifact
		// will never be reused — drop it. Best-effort.
		await cleanupProviderCheckpointArtifact(projectId, job.jobId);
		throw error;
	}

	console.log(`[AI] Job ${job.jobId}: Done. Saved ${resultId} (${finalBuf.length} bytes)`);
}
