import { v4 as uuid } from "uuid";
import { createHash } from "crypto";
import { loadConfig, serverConfig } from "../config.js";
import { aiQueueAdmissionRejections, usageQuotaRejections } from "../middleware/metrics.js";
import { buildCleanPrompt, buildPrompt } from "../prompt/builder.js";
import { assertAssetReadyForAiAuthoritative, getAssetRecordAuthoritative } from "./assets.js";
import { estimateAiJobCost, resolveAiJobQuality } from "./cost-estimator.js";
import { moderatePrompt } from "./moderation.js";
import { normalizeWorkspacePlanId, resolveWorkspacePlanAiQueueCaps, workspacePlanAllowsAiQuality, resolveWorkspacePlan } from "./plans.js";
import { resolveWorkspacePlanIdForProject } from "./billing-store.js";
import { isProviderKilled, listAvailableSfxProviders, resolveSfxTierDispatchProviders, isSfxDisabled } from "./provider-controls.js";
import { projectCatalogStore } from "./project-catalog.js";
import { consume as consumeCredits, releaseConsumption as releaseCreditConsumption, releaseConsumptionsByRef, hasCreditSystem, CreditServiceError } from "./credits.js";
import { resolveAiTierProviderRoute, listAvailableOfficialProviderCandidates } from "./provider-routing.js";
import { QueueAdmissionError, QueueClaimStolenError, jobQueue, readQueueAdmissionLimits } from "./queue.js";
import { objectStorage } from "./storage.js";
import { byoApiService, resolveWorkspaceIdForProject } from "./byo-api.js";
import { readProjectStateFileGuarded } from "../utils/project-state-file.js";
import { clampCrop } from "../utils/security.js";
import {
	UsageQuotaExceededError,
	getLedgerActorUserId,
	reserveAiCredit,
	settleAiCreditReservation,
	summarizeWorkspaceUsage,
} from "./usage-ledger.js";
import { emitQuotaTransitionBestEffort } from "./billing-notifications.js";
import type { AiJob, AiTier, ProjectState } from "../types/index.js";
import type { AiImageQuality } from "../types/index.js";
import type { QueueAdmissionLimits } from "./queue.js";

const LANG_NAMES: Record<string, string> = {
	th: "Thai",
	en: "English",
	ko: "Korean",
	ja: "Japanese",
	zh: "Chinese",
	es: "Spanish",
	fr: "French",
	pt: "Portuguese",
	de: "German",
};
const MAX_EXPLICIT_IDEMPOTENCY_KEY_LENGTH = 300;

export interface AiJobSubmissionInput {
	projectId: string;
	imageId: string;
	crop: { x: number; y: number; w: number; h: number };
	lang: string;
	customPrompt?: string;
	textLayers?: string[];
	translateSfx?: boolean;
	tier: AiTier;
	quality?: AiImageQuality;
}

export interface AiJobSubmissionResult {
	jobId: string;
	prompt: string;
	tier: AiTier;
	quality?: AiImageQuality;
	costEstimate?: AiJob["costEstimate"];
	creditReservation?: AiJob["creditReservation"];
	reused: boolean;
}

export class AiJobSubmissionError extends Error {
	readonly status: number;
	readonly body: Record<string, unknown>;
	readonly retryAfter?: number;

	constructor(status: number, body: Record<string, unknown>, retryAfter?: number) {
		super(typeof body.error === "string" ? body.error : "AI job was not queued");
		this.name = "AiJobSubmissionError";
		this.status = status;
		this.body = body;
		this.retryAfter = retryAfter;
	}
}

function providerUnavailable(config: ReturnType<typeof loadConfig>, tier: AiTier): {
	error: string;
	reason: string;
	provider: string;
} | null {
	const route = resolveAiTierProviderRoute(tier);
	if (!route.implemented) {
		return {
			error: `${route.label} provider adapter (${route.providerHint}) is not implemented yet.`,
			reason: "adapter_pending",
			provider: route.providerHint,
		};
	}

	// SFX-controlled tier (sfx-pro): availability is governed by the SFX controls,
	// using the SAME gating the processor applies (resolveSfxTierDispatchProviders) so
	// the submit-gate and execution agree. `disabled` blocks; an explicit pin restricts;
	// otherwise it defers to the official-default candidates so AI_DEFAULT_PROVIDER
	// (incl. OpenRouter-only) is honored for SFX, and per-provider kill switches drop a
	// candidate. The legacy `sfx` adapter (no implemented tier uses it today) keeps its
	// original gate.
	if (route.sfxControlled) {
		if (isSfxDisabled(config)) {
			return {
				error: `${route.label} is disabled by the SFX provider mode.`,
				reason: "sfx_provider_disabled",
				provider: route.providerHint,
			};
		}
		if (resolveSfxTierDispatchProviders(config).length > 0) return null;
		return {
			error: "SFX Pro is not available. Check the SFX provider mode / kill switches, or enable OpenAI/OpenRouter (or the Python worker).",
			reason: "sfx_provider_unavailable",
			provider: route.providerHint,
		};
	}
	if (route.adapter === "sfx") {
		const providers = listAvailableSfxProviders(config);
		if (providers.length > 0) return null;
		return {
			error: "SFX Pro is not available. Enable the Python worker provider or configure an SFX fallback.",
			reason: "sfx_provider_unavailable",
			provider: route.providerHint,
		};
	}

	// Official-API tiers (clean): allow the submit when ANY configured official
	// provider can serve the tier — honoring AI_DEFAULT_PROVIDER=openrouter, which the
	// processor uses via resolveOfficialProvider(). Previously this required OpenAI
	// specifically, so an OpenRouter-only platform could never queue a clean job even
	// though the processor would have run it on OpenRouter (codex P1 #1).
	if (route.adapter === "openai-image" || route.adapter === "openrouter-image") {
		const available = listAvailableOfficialProviderCandidates(config);
		if (available.length > 0) return null;
		// No candidate can serve it. Surface the configured default provider's reason
		// for the clearest operator message.
		const defaultIsOpenRouter = config.aiDefaultProvider === "openrouter";
		if (isProviderKilled(config, route.providerHint)) {
			return {
				error: `${route.label} provider (${route.providerHint}) is disabled.`,
				reason: "provider_disabled",
				provider: route.providerHint,
			};
		}
		if (defaultIsOpenRouter) {
			return {
				error: `${route.label} requires OpenRouter to be enabled with an API key (or OpenAI image generation as fallback).`,
				reason: "openrouter_not_configured",
				provider: route.providerHint,
			};
		}
		return {
			error: `${route.label} requires OpenAI image generation to be enabled with an API key (or OpenRouter as fallback).`,
			reason: "openai_images_not_configured",
			provider: route.providerHint,
		};
	}

	return null;
}

function buildAiJobPrompt(input: AiJobSubmissionInput): string {
	if (input.tier === "sfx-pro") {
		return buildPrompt({
			lang: LANG_NAMES[input.lang] || input.lang,
			langCode: input.lang,
			customPrompt: input.customPrompt,
			textLayers: input.textLayers,
			translateSfx: input.translateSfx,
		});
	}

	return buildCleanPrompt({ customPrompt: input.customPrompt });
}

async function resolveCostCrop(input: Pick<AiJobSubmissionInput, "projectId" | "imageId" | "crop">): Promise<{ x: number; y: number; w: number; h: number }> {
	const asset = await getAssetRecordAuthoritative(input.projectId, input.imageId);
	if (asset && asset.width > 0 && asset.height > 0) {
		return clampCrop(input.crop, asset.width, asset.height);
	}

	const imageBuf = await objectStorage.getProjectImage({ projectId: input.projectId, imageId: input.imageId });
	if (!imageBuf) {
		throw new AiJobSubmissionError(404, { error: "Image not found" });
	}

	const sharp = await import("sharp");
	const metadata = await sharp.default(imageBuf).metadata();
	if (!metadata.width || !metadata.height) {
		throw new AiJobSubmissionError(422, {
			error: "Image dimensions could not be read for AI cost reservation",
			code: "ai_image_dimensions_unavailable",
		});
	}

	return clampCrop(input.crop, metadata.width, metadata.height);
}

export async function estimateAiJobSubmissionCost(input: Pick<AiJobSubmissionInput, "projectId" | "imageId" | "crop" | "tier" | "quality"> & {
	prompt?: string;
}): Promise<NonNullable<AiJob["costEstimate"]>> {
	const costCrop = await resolveCostCrop(input);
	return estimateAiJobCost({ tier: input.tier, crop: costCrop, quality: input.quality, prompt: input.prompt });
}

export async function resolveAiJobPlanId(projectId: string): Promise<string | undefined> {
	// Postgres production: the catalog join already reflects the assigned plan
	// from workspace_billing_accounts.
	const catalogPlan = await projectCatalogStore?.getProjectWorkspacePlan(projectId);
	const catalogPlanId = normalizeWorkspacePlanId(catalogPlan?.planId);
	if (catalogPlanId) return catalogPlanId;
	// File mode (no Postgres catalog): route through the billing store so a plan
	// assigned via PUT /api/billing/:workspaceId/plan drives AI admission instead
	// of silently using the WORKSPACE_PLAN_ID env default. The resolver itself
	// falls back to that env var when no plan is assigned.
	return resolveWorkspacePlanIdForProject(projectId);
}

export async function resolveAiJobAdmissionLimits(projectId: string): Promise<QueueAdmissionLimits> {
	const planId = await resolveAiJobPlanId(projectId);
	const planCaps = resolveWorkspacePlanAiQueueCaps(planId);
	const baseLimits = readQueueAdmissionLimits();
	return {
		...baseLimits,
		maxProjectOpenJobs: Math.min(baseLimits.maxProjectOpenJobs, planCaps.maxProjectOpenJobs),
		maxProjectPendingJobs: Math.min(baseLimits.maxProjectPendingJobs, planCaps.maxProjectPendingJobs),
	};
}

export async function assertAiQualityAllowedForProject(projectId: string, quality: AiImageQuality): Promise<void> {
	const planId = await resolveAiJobPlanId(projectId);
	if (workspacePlanAllowsAiQuality(planId, quality)) return;
	const plan = resolveWorkspacePlan(planId);
	throw new AiJobSubmissionError(402, {
		error: `AI image quality '${quality}' is not included in the ${plan.name} plan`,
		code: "ai_quality_not_allowed",
		quality,
		plan: {
			id: plan.id,
			name: plan.name,
			allowedAiQualities: plan.allowedAiQualities,
		},
	});
}

async function releaseAiCreditReservationBestEffort(input: {
	projectId: string;
	jobId: string;
	amountThb: number;
	reason: string;
}): Promise<boolean> {
	try {
		await settleAiCreditReservation({
			projectId: input.projectId,
			jobId: input.jobId,
			status: "released",
			amountThb: input.amountThb,
			reason: input.reason,
		});
		return true;
	} catch (error) {
		console.warn(`[AI] Failed to release credit reservation for rejected job ${input.jobId}: ${error}`);
		return false;
	}
}

async function resolveCreditWorkspaceId(projectId: string): Promise<string> {
	const catalogState = await projectCatalogStore?.getProjectState(projectId);
	const catalogWorkspaceId = catalogState?.workspaceId?.trim();
	if (catalogWorkspaceId) return catalogWorkspaceId;
	// Tombstone-aware fallback: a permanently-deleted project must not have its
	// stale state.json resurrected to attribute credit accounting to a workspace.
	const state = readProjectStateFileGuarded<{ workspaceId?: string }>(projectId);
	const workspaceId = state?.workspaceId?.trim();
	if (workspaceId) return workspaceId;
	return projectId;
}

export async function resolvePromptModerationWorkspaceId(projectId: string): Promise<string> {
	const catalogState = await projectCatalogStore?.getProjectState(projectId);
	const catalogStateWorkspaceId = catalogState?.workspaceId?.trim();
	if (catalogStateWorkspaceId) return catalogStateWorkspaceId;
	const catalogPlan = await projectCatalogStore?.getProjectWorkspacePlan(projectId);
	const catalogWorkspaceId = catalogPlan?.workspaceId?.trim();
	if (catalogWorkspaceId) return catalogWorkspaceId;
	// Tombstone-aware fallback (mirrors resolveCreditWorkspaceId): a deleted
	// project must not re-derive a workspace from a stale on-disk state.json.
	const state = readProjectStateFileGuarded<Pick<ProjectState, "workspaceId">>(projectId);
	if (state?.workspaceId?.trim()) return state.workspaceId.trim();
	return projectId;
}

async function releaseConsumedCreditsBestEffort(input: {
	workspaceId: string;
	userId?: string;
	refId: string;
	consumed?: Array<{ creditClass: "shareable" | "personal"; amount: number }>;
	reason: string;
}): Promise<void> {
	if (!input.userId || !input.consumed?.length) return;
	for (const item of input.consumed) {
		try {
			await releaseCreditConsumption(input.workspaceId, input.userId, item.amount, item.creditClass, input.reason, input.refId);
		} catch (error) {
			console.warn(`[AI] Failed to release ${item.creditClass} credits for rejected job ${input.refId}: ${error}`);
		}
	}
}

/**
 * Reconcile the billing of a stale idempotency claim's DEAD owner during takeover
 * (money P1 #2). The owner CHARGED (consumed credits + reserved usage keyed by its
 * own jobId) but crashed before jobQueue.add, so no queue job will ever settle it.
 * Release both ledgers by that dead jobId so nothing leaks, BEFORE the taker
 * re-contends and charges its own fresh job. Both releases are idempotent
 * (releaseConsumptionsByRef is keyed+dedup'd on the ref; settle returns the
 * existing terminal event), so a duplicate takeover is harmless.
 */
async function reconcileStaleClaimBilling(input: {
	projectId: string;
	staleJobId: string;
	amountThb: number;
}): Promise<void> {
	try {
		await releaseConsumptionsByRef(input.staleJobId, "idempotency_claim_orphan_recovered");
	} catch (error) {
		console.warn(`[AI] Failed to release orphaned consumption for stale claim job ${input.staleJobId}: ${error}`);
	}
	await releaseAiCreditReservationBestEffort({
		projectId: input.projectId,
		jobId: input.staleJobId,
		amountThb: input.amountThb,
		reason: "idempotency_claim_orphan_recovered",
	});
}

export async function submitAiJob(input: AiJobSubmissionInput, options: { idempotencyKey?: string; actorUserId?: string } = {}): Promise<AiJobSubmissionResult> {
	if (!(await objectStorage.hasProjectImage({ projectId: input.projectId, imageId: input.imageId }))) {
		throw new AiJobSubmissionError(404, { error: "Image not found" });
	}

	try {
		await assertAssetReadyForAiAuthoritative(input.projectId, input.imageId, {
			requireRegistry: serverConfig.aiRequireAssetRegistryForAi,
		});
	} catch (error) {
		throw new AiJobSubmissionError(423, {
			error: error instanceof Error ? error.message : "Asset is not ready for AI",
		});
	}

	const prompt = buildAiJobPrompt(input);
	const requestedQuality = resolveAiJobQuality(input.tier, input.quality);
	const config = loadConfig();
	const workspaceId = await resolveWorkspaceIdForProject(input.projectId);
	const hasByoRoute = workspaceId ? Boolean(await byoApiService.getWorkspaceByoProvider(workspaceId)) : false;
	// Fold BYO routing into the deterministic idempotency key so a BYO-backed job
	// (no credit reservation, prompt moderation skipped) and a platform-backed job
	// for the same crop/prompt never collide. Without this, a failed/route-revoked
	// BYO job whose user then removes the key and resubmits would reuse the old BYO
	// job instead of creating a moderated, credit-reserved platform job.
	const idempotency = resolveAiSubmitIdempotency(input, prompt, requestedQuality, hasByoRoute, options.idempotencyKey);
	let existingJob = await jobQueue.getByIdempotencyKey(idempotency.key);
	if (existingJob && idempotency.legacyKey) {
		existingJob = await jobQueue.registerIdempotencyAlias(existingJob.jobId, idempotency.legacyKey) ?? existingJob;
	}
	existingJob ??= await jobQueue.getByIdempotencyKey(idempotency.legacyKey);
	if (existingJob) {
		// An EXPLICIT client `Idempotency-Key` is decoupled from the request payload
		// (unlike the derived hash key, which bakes the whole payload in), so the same
		// key with a DIFFERENT crop/lang/tier/quality/prompt would otherwise silently
		// return the stale job (and its stale charge). That violates idempotency-key
		// semantics — same key MUST mean same request — so reject the mismatch with 409
		// instead of returning an unrelated job.
		if (idempotency.explicit) {
			assertExplicitIdempotencyPayloadMatches(existingJob, input, prompt, requestedQuality);
		}
		return {
			jobId: existingJob.jobId,
			prompt: existingJob.prompt,
			tier: existingJob.tier ?? input.tier,
			quality: existingJob.quality,
			costEstimate: existingJob.costEstimate,
			creditReservation: existingJob.creditReservation,
			reused: true,
		};
	}
	await assertAiQualityAllowedForProject(input.projectId, requestedQuality);

	const unavailable = hasByoRoute ? null : providerUnavailable(config, input.tier);
	if (unavailable) {
		throw new AiJobSubmissionError(409, {
			error: unavailable.error,
			code: "ai_provider_unavailable",
			reason: unavailable.reason,
			tier: input.tier,
			provider: unavailable.provider,
		});
	}

	// BYO routes use the customer's own provider key and run image-stage CSAM
	// moderation in byo-api.ts instead of platform prompt moderation, so the
	// platform prompt-moderation gate is skipped only when a BYO route is active.
	let promptModeration:
		| Awaited<ReturnType<typeof moderatePrompt>>
		| undefined;
	if (!hasByoRoute && config.promptModerationEnabled) {
		const moderationWorkspaceId = await resolvePromptModerationWorkspaceId(input.projectId);
		promptModeration = await moderatePrompt(prompt, moderationWorkspaceId);
		if (promptModeration.decision === "block") {
			throw new AiJobSubmissionError(403, {
				error: "Prompt blocked by moderation",
				code: promptModeration.status === "csam_block" ? "csam_block" : "moderation_blocked",
				moderation: promptModeration,
			});
		}
	}

	const jobId = uuid();
	// Resolve the credit-consuming actor: an explicit option wins, otherwise fall
	// back to the ambient ledger actor bound by runWithLedgerActor. Every
	// authenticated submission path (translate, AI marker rerun, AI review retry)
	// wraps this call in runWithLedgerActor, so the new personal/shareable credit
	// debit applies consistently even when a caller does not thread actorUserId.
	const actorUserId = options.actorUserId?.trim() || getLedgerActorUserId();
	const creditWorkspaceId = await resolveCreditWorkspaceId(input.projectId);
	const costEstimate = await estimateAiJobSubmissionCost({
		projectId: input.projectId,
		imageId: input.imageId,
		crop: input.crop,
		tier: input.tier,
		quality: input.quality,
		prompt,
	});
	const job: AiJob = {
		jobId,
		projectId: input.projectId,
		imageId: input.imageId,
		crop: input.crop,
		lang: input.lang,
		prompt,
		tier: input.tier,
		quality: costEstimate.quality,
		costEstimate,
		byoQueued: hasByoRoute,
		creditReservation: hasByoRoute
			? undefined
			: {
				status: "reserved",
				amountThb: costEstimate.reserveThb,
				currency: costEstimate.currency,
				createdAt: Date.now(),
			},
		status: promptModeration?.decision === "warn" ? "needs_review" : "pending",
		idempotencyKey: idempotency.key,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	const admissionLimits = await resolveAiJobAdmissionLimits(input.projectId);
	const admission = await jobQueue.checkAdmission(job, admissionLimits);
	if (!admission.accepted) {
		const reason = admission.reason ?? "unknown";
		aiQueueAdmissionRejections.inc({ reason });
		throw new AiJobSubmissionError(
			admission.reason === "queue_draining" ? 503 : 429,
			{
				error: admission.reason === "queue_draining" ? "AI queue is draining" : "AI queue capacity exceeded",
				code: admission.reason === "queue_draining" ? "ai_queue_draining" : "ai_queue_capacity_exceeded",
				reason,
				retryAfter: admission.retryAfterSeconds,
				queue: {
					snapshot: admission.snapshot,
					limits: admission.limits,
				},
			},
			admission.retryAfterSeconds,
		);
	}

	// ATOMIC IDEMPOTENCY CLAIM (codex money P1 #1): take ownership of the idempotency
	// key(s) under the queue mutation lock BEFORE consuming credits / reserving usage.
	// Two concurrent duplicate submits previously both passed the read-only
	// getByIdempotencyKey check above, both charged, and only de-duped at jobQueue.add
	// — so the loser refunded against its own fresh jobId (not the deduped subject)
	// and leaked the usage reservation. Claiming here makes exactly ONE submit the
	// owner that proceeds to charge; the loser learns it lost BEFORE charging anything
	// and returns the winner's job having spent nothing.
	const idempotencyClaimKeys = [idempotency.key, idempotency.legacyKey];
	const claim = await jobQueue.claimIdempotency(idempotencyClaimKeys, jobId);
	if (claim.status === "reused") {
		// Preserve the explicit-key 409-on-payload-mismatch contract (#316) even when a
		// CONCURRENT duplicate de-dupes via the atomic claim rather than the read above:
		// the same explicit key with a different crop/lang/tier/quality/prompt must still
		// be rejected, not silently handed the winner's job.
		if (idempotency.explicit) {
			assertExplicitIdempotencyPayloadMatches(claim.job, input, prompt, requestedQuality);
		}
		return buildReusedResult(claim.job, input);
	}
	if (claim.status === "pending") {
		const winner = await waitForClaimedJob(claim.jobId);
		if (winner) {
			if (idempotency.explicit) {
				assertExplicitIdempotencyPayloadMatches(winner, input, prompt, requestedQuality);
			}
			return buildReusedResult(winner, input);
		}
		// The peer's claim never materialized within the bound — it either failed before
		// add and released its claim, or it DIED mid-flight leaving an ORPHANED claim
		// (e.g. a crashed replica in the shared redis store). Take over the stale claim
		// ATOMICALLY (money P1 #2): this reassigns the key to OUR jobId (fencing the dead
		// or merely-slow owner out of a later add()/settle) and tells us whether the dead
		// owner had already CHARGED. If it had, we MUST release that owner's consumption +
		// reservation BEFORE we contend, so nothing leaks and we don't double-charge by
		// reusing a dead reservation.
		const newJobId = uuid();
		const takeover = await jobQueue.takeOverStaleIdempotencyClaim(idempotencyClaimKeys, claim.jobId, newJobId);
		if (takeover.status === "reused") {
			if (idempotency.explicit) {
				assertExplicitIdempotencyPayloadMatches(takeover.job, input, prompt, requestedQuality);
			}
			return buildReusedResult(takeover.job, input);
		}
		if (takeover.status === "taken" && takeover.charged) {
			await reconcileStaleClaimBilling({
				projectId: input.projectId,
				staleJobId: takeover.staleJobId,
				amountThb: costEstimate.reserveThb,
			});
		}
		if (takeover.status === "taken") {
			// We now own a FRESH claim under newJobId; release it before re-contending so
			// the recursive submit can claim cleanly (the dead owner's billing, if any, is
			// already reconciled). releaseIdempotencyClaim only clears a still-dangling
			// claim owned by newJobId, never a real job.
			await jobQueue.releaseIdempotencyClaim(idempotencyClaimKeys, newJobId);
		}
		// takeover.status === "notFound": the claim already vanished. Either way,
		// re-contend from the top so a fresh claim can be taken.
		return submitAiJob(input, options);
	}
	// claim.status === "claimed": we own the key. Any failure before a successful
	// jobQueue.add MUST release the claim so a legitimate resubmit is not wedged.
	let claimReleased = false;
	const releaseClaim = async (): Promise<void> => {
		if (claimReleased) return;
		claimReleased = true;
		await jobQueue.releaseIdempotencyClaim(idempotencyClaimKeys, jobId);
	};

	try {
		return await chargeReserveAndQueue();
	} catch (error) {
		await releaseClaim();
		throw error;
	}

	async function chargeReserveAndQueue(): Promise<AiJobSubmissionResult> {
	// BYO routes are billed against the customer's own provider key, so they skip
	// both the opt-in credit consumption and the platform usage-ledger reservation.
	let consumedCredits: Array<{ creditClass: "shareable" | "personal"; amount: number }> | undefined;
	if (!hasByoRoute) {
		// Flag the claim as needs-reconcile BEFORE the first irreversible billing write
		// (money P1 #2). Previously this mark happened AFTER consumeCredits +
		// reserveAiCredit, leaving a crash window: if THIS owner died after the credit
		// debit (or after the usage reservation) but before the mark, the persisted claim
		// still read charged:false, so a stale-claim taker SKIPPED reconcileStaleClaimBilling
		// and the dead jobId's consumption + reservation LEAKED. Marking first closes that
		// window. OVER-marking is safe: a stale takeover reconciles by releasing THIS
		// jobId's consumption + reservation, and both releases are idempotent NO-OPS when
		// nothing was actually written (releaseConsumptionsByRef filters out a never-debited
		// ref → []; settleAiCreditReservation for a never-reserved jobId records a phantom
		// "released" event with reservedThb:0 that the summary counts as neither captured
		// nor active-reserved → zero billing effect). This only affects WHETHER a takeover
		// reconciles, never WHETHER a charge happens — the atomic single-winner claim still
		// guarantees exactly-once charge, so there is no double-charge. If THIS owner instead
		// FAILS before add (credit/usage error, queue rejection), the outer catch releases
		// the whole claim (releaseIdempotencyClaim deletes the row), so the early mark is moot.
		await jobQueue.markIdempotencyClaimCharged(idempotencyClaimKeys, jobId);

		// Credits are an opt-in SaaS layer: only enforce them when this workspace+user
		// actually has credits granted. Workspaces that have never been provisioned with
		// shareable/personal credits fall through to the existing usage-ledger quota,
		// so prototype/free usage is not blocked with a 402.
		if (actorUserId && hasCreditSystem(creditWorkspaceId, actorUserId)) {
			try {
				// Charge the personal/shareable credit buckets the SIZE-FLAT per-op CREDIT
				// price (QUALITY_CREDIT_UNITS: low=1 / medium=9 / high=36 — surfaced as
				// costEstimate.creditUnits), NOT the THB reserve. The buckets are granted in
				// credit units (coupons/SKUs grant `aiCredits` counts, plans grant
				// `monthlyAiCredits`), so debiting reserveThb (a ~2-5 THB value) from a
				// count-denominated balance over-charged ~2-5× and contradicted the UI quote
				// ("N เครดิต / ครั้ง"). The usage-ledger reservation below stays THB.
				const creditUnitsToCharge = costEstimate.creditUnits ?? costEstimate.reserveThb;
				const result = await consumeCredits(creditWorkspaceId, actorUserId, creditUnitsToCharge, "ai_job_submitted", jobId);
				consumedCredits = result.consumed;
				// Record the consumption context on the job so the queue can re-charge the
				// credit buckets when a refunded job is retried.
				job.creditConsumption = {
					workspaceId: creditWorkspaceId,
					userId: actorUserId,
					consumedCredits: creditUnitsToCharge,
				};
			} catch (error) {
				if (error instanceof CreditServiceError) {
					throw new AiJobSubmissionError(error.status, { error: error.message, code: error.code });
				}
				throw error;
			}
		}

		// Snapshot the monthly AI-credit usage % BEFORE the reservation so we can fire a
		// ONE-TIME quota notification on the 80%/100% threshold-CROSSING below. Best-effort
		// — a summarize failure must never block the reservation, so default to null.
		let beforePercent: number | null = null;
		try {
			beforePercent = (await summarizeWorkspaceUsage(input.projectId)).monthly.percentUsed.aiCredit;
		} catch {
			beforePercent = null;
		}
		try {
			const { summary: afterSummary } = await reserveAiCredit({
				workspaceId: creditWorkspaceId,
				projectId: input.projectId,
				jobId,
				amountThb: costEstimate.reserveThb,
				// Key the reservation idempotency by THIS jobId (the ledger's own default),
				// NOT by idempotency.key. The atomic claim already guarantees exactly ONE
				// winner per idempotency.key reaches this charge, so per-key dedup is
				// unnecessary here — and a SHARED-by-key reservation key let a crash-takeover
				// RETRY (a NEW jobId reusing the same idempotency.key) silently re-bind to the
				// CRASHED owner's reservation event (subjectId = crashed jobId), which the
				// retry could never settle by its own jobId — leaking the reservation
				// (money P1 #2). Per-jobId keeps each winner's reservation settleable by its
				// own jobId; the dead owner's reservation is released during claim takeover.
				idempotencyKey: `ai-credit-reserve:${jobId}`,
				metadata: {
					tier: input.tier,
					imageId: input.imageId,
					estimatedThb: costEstimate.estimatedThb,
					reserveThb: costEstimate.reserveThb,
				},
			});
			// AFTER a SUCCESSFUL reservation: fire the one-time 80%/100% quota notice on
			// the threshold-CROSSING. The emitter swallows its own errors so it can never
			// affect the reservation/charge.
			await emitQuotaTransitionBestEffort({
				workspaceId: creditWorkspaceId,
				actorUserId,
				beforePercent,
				afterPercent: afterSummary.monthly.percentUsed.aiCredit,
			});
		} catch (error) {
			await releaseConsumedCreditsBestEffort({
				workspaceId: creditWorkspaceId,
				userId: actorUserId,
				refId: jobId,
				consumed: consumedCredits,
				reason: "ai_usage_reservation_failed",
			});
			if (error instanceof UsageQuotaExceededError) {
				usageQuotaRejections.inc({ reason: error.reason });
				// REJECTED over-quota request: the reservation FAILED, so committed usage did
				// NOT change — this attempt is NOT a fresh threshold crossing and must emit
				// NOTHING (round-1 forced `afterPercent:100` here, re-firing `quota_frozen` on
				// EVERY blocked attempt — P1-1). The quota_frozen notice fires exactly once, on
				// the SUCCESSFUL reservation that genuinely crosses 100% (the emit in the try
				// block above), durably deduped per workspace+period.
				throw new AiJobSubmissionError(402, {
					error: "Workspace usage quota exceeded",
					code: error.code,
					reason: error.reason,
					attempted: error.attempted,
					usage: error.summary,
				});
			}
			throw error;
		}
		// The claim was already flagged needs-reconcile BEFORE consumeCredits above, so if
		// THIS owner crashes anywhere in this charge path (after the debit, after the
		// reservation, or before jobQueue.add), a stale-claim taker reconciles (releases)
		// this jobId's consumption + reservation before contending — no leak / double-charge
		// (money P1 #2).
	}

	let queuedJob: AiJob;
	try {
		queuedJob = await jobQueue.add(job, {
			idempotencyKey: idempotency.key,
			idempotencyAliases: idempotency.legacyKey ? [idempotency.legacyKey] : undefined,
			admissionLimits,
			// Fence: if our claim was taken over while we were slow, add() rejects with
			// QueueClaimStolenError instead of materializing a SECOND active job/charge.
			expectClaimJobId: jobId,
		});
	} catch (error) {
		// Our claim was stolen by a stale-claim taker that already reconciled (released)
		// THIS jobId's billing during takeover. Refund our own charge (idempotent — the
		// taker may have already released it; releaseConsumptionsByRef/settle are no-ops
		// once released) and de-dupe onto the live winner instead of creating a second
		// job. The claim is NOT ours to release (the taker owns it now), so suppress the
		// outer releaseClaim by marking it handled.
		if (error instanceof QueueClaimStolenError) {
			claimReleased = true;
			if (!hasByoRoute) {
				// IDEMPOTENT refund: the taker already released THIS jobId's consumption
				// during its takeover (reconcileStaleClaimBilling). Use releaseConsumptionsByRef
				// (keyed on jobId, skips already-released amounts) — NOT releaseConsumption,
				// which records an unconditional negative and would DOUBLE-refund. settle is
				// idempotent (returns the existing terminal event), so a second release is a
				// no-op.
				try {
					await releaseConsumptionsByRef(jobId, "idempotency_claim_stolen");
				} catch (releaseError) {
					console.warn(`[AI] Failed to release consumption for stolen claim job ${jobId}: ${releaseError}`);
				}
				await releaseAiCreditReservationBestEffort({
					projectId: input.projectId,
					jobId,
					amountThb: costEstimate.reserveThb,
					reason: "idempotency_claim_stolen",
				});
			}
			const winner = (error.currentClaimJobId ? await waitForClaimedJob(error.currentClaimJobId) : undefined)
				?? await jobQueue.getByIdempotencyKey(idempotency.key)
				?? await jobQueue.getByIdempotencyKey(idempotency.legacyKey);
			if (winner) {
				if (idempotency.explicit) {
					assertExplicitIdempotencyPayloadMatches(winner, input, prompt, requestedQuality);
				}
				return buildReusedResult(winner, input);
			}
			// The taker hasn't materialized yet; re-contend from the top.
			return submitAiJob(input, options);
		}
		if (!hasByoRoute) {
			await releaseConsumedCreditsBestEffort({
				workspaceId: creditWorkspaceId,
				userId: actorUserId,
				refId: jobId,
				consumed: consumedCredits,
				reason: "queue_rejected",
			});
			await releaseAiCreditReservationBestEffort({
				projectId: input.projectId,
				jobId,
				amountThb: costEstimate.reserveThb,
				reason: "queue_rejected",
			});
		}
		if (error instanceof QueueAdmissionError) {
			const reason = error.admission.reason ?? "unknown";
			aiQueueAdmissionRejections.inc({ reason });
			throw new AiJobSubmissionError(
				error.admission.reason === "queue_draining" ? 503 : 429,
				{
					error: error.message,
					code: error.admission.reason === "queue_draining" ? "ai_queue_draining" : "ai_queue_capacity_exceeded",
					reason,
					retryAfter: error.admission.retryAfterSeconds,
					queue: {
						snapshot: error.admission.snapshot,
						limits: error.admission.limits,
					},
				},
				error.admission.retryAfterSeconds,
			);
		}
		const message = error instanceof Error ? error.message : "Queue rejected the job";
		aiQueueAdmissionRejections.inc({ reason: "queue_draining" });
		throw new AiJobSubmissionError(503, { error: message, code: "ai_queue_draining", retryAfter: 30 }, 30);
	}

	const reused = queuedJob.jobId !== jobId;
	if (reused && !hasByoRoute) {
		// We charged but add() de-duped onto a pre-existing real job, so refund OUR
		// jobId's charge. Use releaseConsumptionsByRef (idempotent, keyed on jobId) not
		// releaseConsumption: if a stale-claim taker had already reconciled this jobId's
		// consumption during a takeover, an unconditional releaseConsumption would
		// DOUBLE-refund. settle is idempotent (returns the existing terminal event).
		try {
			await releaseConsumptionsByRef(jobId, "queue_reused_existing_job");
		} catch (releaseError) {
			console.warn(`[AI] Failed to release consumption for reused job ${jobId}: ${releaseError}`);
		}
		await settleAiCreditReservation({
			projectId: input.projectId,
			jobId,
			status: "released",
			amountThb: costEstimate.reserveThb,
			reason: "queue_reused_existing_job",
		});
	} else if (hasByoRoute) {
		// Event-log writes are best-effort observability: never let a recordEvent
		// throw (e.g. a Redis timeout now that the queue's sends are bounded, #4 E)
		// propagate past add() — that would leak the reserved/consumed credits the
		// release logic below is responsible for returning (#4 F).
		try {
			await jobQueue.recordEvent(queuedJob.jobId, "byo:queued", "BYO job queued without reserving workspace credits", {
				costEstimate: queuedJob.costEstimate,
				creditReservation: queuedJob.creditReservation,
			});
		} catch (eventError) {
			console.warn(`[AI] Failed to record byo:queued event for ${queuedJob.jobId}: ${eventError instanceof Error ? eventError.message : String(eventError)}`);
		}
	} else {
		try {
			await jobQueue.recordEvent(queuedJob.jobId, "credit:reserved", "Prototype credit reserve recorded", {
				costEstimate: queuedJob.costEstimate,
				creditReservation: queuedJob.creditReservation,
			});
		} catch (eventError) {
			console.warn(`[AI] Failed to record credit:reserved event for ${queuedJob.jobId}: ${eventError instanceof Error ? eventError.message : String(eventError)}`);
		}
		if (promptModeration?.decision === "warn") {
			// best-effort: a throw here would skip the reserved+consumed credit
			// release immediately below, leaking credits for a parked needs_review
			// job that never runs (#4 F).
			try {
				await jobQueue.recordEvent(queuedJob.jobId, "moderation:needs_review", "Prompt moderation warning requires admin/QC release before processing", {
					reason: promptModeration.reason,
					status: promptModeration.status,
					rulesetVersion: promptModeration.ruleset_version,
				});
			} catch (eventError) {
				console.warn(`[AI] Failed to record moderation:needs_review event for ${queuedJob.jobId}: ${eventError instanceof Error ? eventError.message : String(eventError)}`);
			}
			// A `needs_review` job is parked: the queue never claims it
			// (claimPendingJobs only takes "pending") and adding it directly as
			// `needs_review` fires no status transition, so the queue's settlement
			// never releases the reservation. Release the reserved credit now to avoid
			// leaking it for the full reservation lifetime. A future admin/QC
			// review-release path re-reserves before re-queuing the job as "pending".
			const released = await releaseAiCreditReservationBestEffort({
				projectId: input.projectId,
				jobId: queuedJob.jobId,
				amountThb: costEstimate.reserveThb,
				reason: "moderation_needs_review",
			});
			// The job also DEBITED the personal/shareable credit bucket at submission
			// (consumeCredits above). A parked needs_review job never runs, so that
			// bucket consumption must be refunded too, otherwise the user is charged
			// credits for a job that never dispatched. The queue bucket refund only
			// fires for retriable terminal states (error/cancelled/blocked), and this
			// job was ADDED directly as needs_review (no status transition), so the
			// refund must happen here to keep reserve/refund symmetric. Idempotent
			// (releaseConsumptionsByRef keyed on jobId), so a later review-release that
			// re-consumes before re-queueing is unaffected.
			await releaseConsumedCreditsBestEffort({
				workspaceId: creditWorkspaceId,
				userId: actorUserId,
				refId: queuedJob.jobId,
				consumed: consumedCredits,
				reason: "moderation_needs_review",
			});
			// Only mark the job reservation as `released` once the ledger settlement
			// actually succeeded. If the usage ledger was temporarily unavailable the
			// real reservation is still open, so we must keep the job record's
			// reservation as `reserved` (the queue's needs_review→released settlement
			// path can then retry the release on a later transition) instead of
			// orphaning a stuck ledger entry behind a `released` job record.
			if (released) {
				const releasedReservation: AiJob["creditReservation"] = {
					...queuedJob.creditReservation!,
					status: "released",
					settledAt: Date.now(),
					reason: "moderation_needs_review",
				};
				await jobQueue.update(queuedJob.jobId, { creditReservation: releasedReservation });
				queuedJob.creditReservation = releasedReservation;
			} else {
				await jobQueue.recordEvent(queuedJob.jobId, "credit:release_pending", "Credit ledger unavailable; needs_review reservation remains reserved for later settlement", {
					amountThb: costEstimate.reserveThb,
					reason: "moderation_needs_review",
				});
			}
		}
	}

	return {
		jobId: queuedJob.jobId,
		prompt,
		tier: queuedJob.tier ?? input.tier,
		quality: queuedJob.quality,
		costEstimate: queuedJob.costEstimate,
		creditReservation: queuedJob.creditReservation,
		reused,
	};
	}
}

// Build the `reused: true` result returned to a caller whose submit de-duped onto
// an existing job (an idempotent retry, or the loser of a concurrent same-key race
// that charged nothing).
function buildReusedResult(existingJob: AiJob, input: AiJobSubmissionInput): AiJobSubmissionResult {
	return {
		jobId: existingJob.jobId,
		prompt: existingJob.prompt,
		tier: existingJob.tier ?? input.tier,
		quality: existingJob.quality,
		costEstimate: existingJob.costEstimate,
		creditReservation: existingJob.creditReservation,
		reused: true,
	};
}

// Maximum time the loser of a concurrent same-key submit waits for the winning
// submit to materialize its job after winning the idempotency claim. The winner
// only has to finish its credit-debit + usage-reserve + queue.add under the queue
// mutation lock, which is sub-second; this bound just prevents an unbounded wait if
// the winner crashes mid-flight (in which case it releases the claim and the loser
// re-contends).
function readClaimMaterializeTimeoutMs(): number {
	const raw = process.env.AI_CLAIM_MATERIALIZE_TIMEOUT_MS;
	if (raw) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return 5_000;
}
const CLAIM_MATERIALIZE_POLL_MS = 10;

// Wait for the winning submit (which holds the idempotency claim for `jobId`) to
// add its real job to the queue, then return it. Returns undefined if the winner
// never materialized within the bound (it failed before add and released the claim).
async function waitForClaimedJob(jobId: string): Promise<AiJob | undefined> {
	const deadline = Date.now() + readClaimMaterializeTimeoutMs();
	for (;;) {
		const job = await jobQueue.get(jobId);
		if (job) return job;
		if (Date.now() >= deadline) return undefined;
		await new Promise((resolve) => setTimeout(resolve, CLAIM_MATERIALIZE_POLL_MS));
	}
}

function resolveAiSubmitIdempotency(
	input: AiJobSubmissionInput,
	prompt: string,
	requestedQuality: AiImageQuality,
	hasByoRoute: boolean,
	explicitKey?: string,
): { key: string; legacyKey?: string; explicit: boolean } {
	if (explicitKey !== undefined) {
		const normalized = explicitKey.trim();
		if (!normalized || normalized.length > MAX_EXPLICIT_IDEMPOTENCY_KEY_LENGTH) {
			throw new AiJobSubmissionError(400, {
				error: "Invalid Idempotency-Key header",
				code: "invalid_idempotency_key",
				maxLength: MAX_EXPLICIT_IDEMPOTENCY_KEY_LENGTH,
			});
		}
		return { key: normalized, explicit: true };
	}

	// Platform jobs keep the ORIGINAL digest shape (no `byo` field) so they stay
	// byte-compatible with jobs queued before BYO existed and still de-dupe via the
	// pre-hash legacy alias. BYO-backed jobs add a `byo` marker so they live in a
	// separate namespace: a failed/route-revoked BYO job whose user then removes the
	// key and resubmits the same crop/prompt creates a fresh moderated, credit-
	// reserved platform job instead of reusing the BYO job.
	const digestPayload: Record<string, unknown> = {
		projectId: input.projectId,
		imageId: input.imageId,
		crop: {
			x: input.crop.x,
			y: input.crop.y,
			w: input.crop.w,
			h: input.crop.h,
		},
		lang: input.lang,
		tier: input.tier,
		quality: requestedQuality,
		prompt,
	};
	if (hasByoRoute) digestPayload.byo = true;
	const digest = createHash("sha256").update(JSON.stringify(digestPayload)).digest("hex");
	return {
		key: `ai-submit:${digest}`,
		// Derived keys bake the whole payload into the hash, so a payload change
		// already yields a different key (no false reuse) — no explicit mismatch check.
		explicit: false,
		// Only platform jobs carry the legacy (pre-hash) alias; BYO is a new
		// namespace with no pre-existing jobs to de-dupe against.
		legacyKey: hasByoRoute
			? undefined
			: `${input.projectId}:${input.imageId}:${JSON.stringify(input.crop)}:${input.lang}:${input.tier}:${requestedQuality}:${prompt}`,
	};
}

// Fingerprint of the request fields that DEFINE an AI job's output/charge. Used to
// detect an explicit-idempotency-key reuse carrying a different payload.
function aiJobPayloadFingerprint(fields: {
	projectId: string;
	imageId: string;
	crop: { x: number; y: number; w: number; h: number };
	lang: string;
	tier: AiTier;
	quality: AiImageQuality | undefined;
	prompt: string;
}): string {
	return createHash("sha256").update(JSON.stringify({
		projectId: fields.projectId,
		imageId: fields.imageId,
		crop: { x: fields.crop.x, y: fields.crop.y, w: fields.crop.w, h: fields.crop.h },
		lang: fields.lang,
		tier: fields.tier,
		quality: fields.quality,
		prompt: fields.prompt,
	})).digest("hex");
}

// Enforce idempotency-key semantics for an EXPLICIT client key: the same key must
// describe the same request. If the stored job's payload differs from the current
// request, reject with 409 instead of silently returning the stale job/charge.
function assertExplicitIdempotencyPayloadMatches(
	existingJob: AiJob,
	input: AiJobSubmissionInput,
	prompt: string,
	requestedQuality: AiImageQuality,
): void {
	const existingFingerprint = aiJobPayloadFingerprint({
		projectId: existingJob.projectId,
		imageId: existingJob.imageId,
		crop: existingJob.crop,
		lang: existingJob.lang,
		tier: existingJob.tier ?? input.tier,
		quality: existingJob.quality,
		prompt: existingJob.prompt,
	});
	const requestFingerprint = aiJobPayloadFingerprint({
		projectId: input.projectId,
		imageId: input.imageId,
		crop: input.crop,
		lang: input.lang,
		tier: input.tier,
		quality: requestedQuality,
		prompt,
	});
	if (existingFingerprint !== requestFingerprint) {
		throw new AiJobSubmissionError(409, {
			error: "Idempotency-Key already used for a different AI request",
			code: "idempotency_key_payload_mismatch",
			existingJobId: existingJob.jobId,
		});
	}
}
