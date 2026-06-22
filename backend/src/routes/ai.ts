// Routes: AI translation + admin config
// Input validation via Zod, path traversal protection

import { Hono } from "hono";
import { z } from "zod/v4";
import { loadConfig, saveConfig, serverConfig, resolveSupportAgentModel } from "../config.js";
import { isValidProjectId, isValidImageId } from "../utils/security.js";
import { readJsonBody } from "../utils/request-body.js";
import { resolveProjectState } from "../utils/project-state-file.js";
import { getAuthUser, optionalAuth, requireAdmin } from "../middleware/auth.middleware.js";
import { isProviderKilled, listAvailableSfxProviders, isSfxDisabled, resolveSfxPinnedProvider, resolveSfxTierDispatchProviders, canUseSfxProvider, SFX_WORKER_PROVIDER_ID } from "../services/provider-controls.js";
import { resolveAiTierProviderRoute, resolveOfficialProviderCandidates } from "../services/provider-routing.js";
import { isSupportedOpenAiImageModel, OPENAI_IMAGE_MODELS } from "../services/ai-providers/openai-models.js";
import { projectCatalogStore } from "../services/project-catalog.js";
import { runWithLedgerActor, summarizeWorkspaceUsage, UsageQuotaExceededError } from "../services/usage-ledger.js";
import { AiJobSubmissionError, assertAiQualityAllowedForProject, estimateAiJobSubmissionCost, resolveAiJobAdmissionLimits, resolveAiJobPlanId, submitAiJob } from "../services/ai-job-submission.js";
import { resolveAiJobQuality } from "../services/cost-estimator.js";
import { resolveWorkspacePlan, workspacePlanAllowsAiQuality } from "../services/plans.js";
import { QueueAdmissionError, QueueIdempotencyConflictError, isRetriableJob, jobQueue } from "../services/queue.js";
import { CreditServiceError } from "../services/credits.js";
import { assertAssetReadyForAiAuthoritative } from "../services/assets.js";
import { byoApiService, resolveWorkspaceIdForProject, type ByoProvider, type ByoTaskType } from "../services/byo-api.js";
import type { AiImageQuality, AiTier, ProjectState, WorkflowTaskType } from "../types/index.js";
import type { JWTPayload } from "../types/auth.js";
import { hasPermission } from "../types/auth.js";

const ai = new Hono();
ai.use("*", optionalAuth);

// LEAK-SAFE (prompt class, sibling to #258/#278): a job-submission result carries
// the full internal system/template `prompt` (the ~900-char `buildPrompt` output).
// The client does NOT need it (the FE only echoed it back onto the marker, which no
// longer stores it) and the owner's standing rule is that the internal prompt must
// NEVER reach the user. Strip it from any submit/rerun/retry response so the prompt
// is never serialized over the wire. The user's own instruction (`customPrompt`) is
// kept on the marker via the create/marker path, not here.
function stripInternalPrompt<T extends { prompt?: unknown }>(result: T): Omit<T, "prompt"> {
	const { prompt: _internalPrompt, ...rest } = result;
	return rest;
}

async function assertRetryAssetReadyForAi(projectId: string, imageId: string): Promise<void> {
	try {
		await assertAssetReadyForAiAuthoritative(projectId, imageId, {
			requireRegistry: serverConfig.aiRequireAssetRegistryForAi,
		});
	} catch (error) {
		throw new AiJobSubmissionError(423, {
			error: error instanceof Error ? error.message : "Asset is not ready for AI",
		});
	}
}

// ── Validation Schemas ───────────────────────────────────────

// Crop is in source-image PIXEL coordinates. We intentionally carry NO hard upper
// bound here: a hard cap (e.g. .max(100000)) would 400 a legitimate crop on an asset
// that an operator's raised upload ceiling allows (MAX_UPLOAD_IMAGE_HEIGHT can reach
// 200000px for webtoon split-source strips — see getUploadImagePixelCeiling /
// getSplitSourcePixelCeiling) BEFORE the server can clamp against the asset's real
// dimensions. The real, asset-aware bound is enforced server-side by clampCrop (which
// fully bounds x/y/w/h to the decoded image and floors to whole pixels). The schema's
// job is only to reject MALFORMED input:
//   • z.number() in Zod v4 is finite-by-default — it rejects NaN/Infinity/-Infinity.
//   • .int() requires whole-pixel coordinates (clampCrop floors anyway) and, as a
//     belt-and-braces second guard, also rejects any non-finite value.
//   • .min(0)/.min(1) reject negatives / zero-area.
// Anything larger than the asset is harmlessly clamped down, never rejected. Exported
// so the bound decision can be unit-tested without queueing a real job.
export const translateCropSchema = z.object({
	x: z.number().int().min(0),
	y: z.number().int().min(0),
	w: z.number().int().min(1),
	h: z.number().int().min(1),
});

const translateSchema = z.object({
	projectId: z.string().min(1),
	imageId: z.string().min(1),
	crop: translateCropSchema,
	lang: z.string().min(1).max(10),
	customPrompt: z.string().max(5000).optional(),
	textLayers: z.array(z.string().max(2000)).max(50).optional(),
	translateSfx: z.boolean().optional(),
	tier: z.enum(["budget-clean", "clean-pro", "sfx-pro"]).default("sfx-pro"),
	quality: z.enum(["low", "medium", "high"]).optional(),
});

const configUpdateSchema = z.object({
	openrouterEnabled: z.boolean().optional(),
	openrouterApiKey: z.string().max(500).optional(),
	openaiImagesEnabled: z.boolean().optional(),
	openaiImageModel: z.string().trim().min(1).max(120).optional(),
	openaiImageDefaultQuality: z.enum(["low", "medium", "high"]).optional(),
	chatgptEnabled: z.boolean().optional(),
	primaryBackend: z.enum(["chatgpt", "openrouter"]).optional(),
	providerKillSwitches: z.object({
		"openai-gpt-image-2": z.boolean().optional(),
		"python-worker": z.boolean().optional(),
		"openrouter-gpt-5.4-image-2": z.boolean().optional(),
		"gemini-flash-lite": z.boolean().optional(),
		"gemini-2.5-flash-image": z.boolean().optional(),
		"gemini-3.1-flash-image-preview": z.boolean().optional(),
	}).optional(),
	sfxProviderMode: z.enum(["auto", "openai-gpt-image-2", "python-worker", "gpt-5.4-image-2", "disabled"]).optional(),
	promptModerationEnabled: z.boolean().optional(),
	imageModerationEnabled: z.boolean().optional(),
	// AI support-agent master kill-switch (rank1). Flip to false to route every
	// support ticket to the human queue without ever calling gpt-5.5, exactly like
	// providerKillSwitches but for the support agent.
	aiSupportEnabled: z.boolean().optional(),
	supportAgentProvider: z.enum(["openai", "openrouter"]).optional(),
	supportAgentModel: z.string().trim().min(1).max(120).optional(),
});

function parseByoTaskType(raw: string | undefined): ByoTaskType | null {
	if (raw === "image" || raw === "text" || raw === "ocr") return raw;
	return null;
}

function parseByoProvider(raw: string | undefined): ByoProvider | undefined | null {
	if (raw === undefined) return undefined;
	if (raw === "openai" || raw === "openrouter") return raw;
	return null;
}

export interface AiProjectAccessDecisionInput {
	stateUserId?: string;
	stateWorkspaceId?: string;
	user?: JWTPayload;
	permission: string;
	language?: string;
	pageIndex?: number;
	taskType?: WorkflowTaskType;
	catalogCanAccess?: (input: { language?: string; pageIndex?: number; taskType?: WorkflowTaskType }) => Promise<boolean>;
}

export async function resolveAiProjectAccess(input: AiProjectAccessDecisionInput): Promise<"allowed" | "unauthorized" | "not_found" | "forbidden"> {
	if (!input.user) {
		return input.stateUserId || input.stateWorkspaceId ? "unauthorized" : "allowed";
	}

	if (input.stateWorkspaceId) {
		if (await input.catalogCanAccess?.({ language: input.language, pageIndex: input.pageIndex, taskType: input.taskType })) return "allowed";
		return "not_found";
	}

	if (input.stateUserId && input.stateUserId !== input.user.userId) {
		if (await input.catalogCanAccess?.({ language: input.language, pageIndex: input.pageIndex, taskType: input.taskType })) return "allowed";
		return "not_found";
	}

	if (!hasPermission(input.user.role, input.permission)) return "forbidden";
	return "allowed";
}

/**
 * Resolve the user to attribute AI usage to. The actor is read ONLY from the
 * authenticated session/JWT (`c.get("user")`), never from a client-supplied
 * header, so it cannot be spoofed. Returns undefined for anonymous prototype
 * requests, leaving usage unattributed rather than falsely attributed.
 */
export function resolveLedgerActorUserId(c: any): string | undefined {
	const user = getAuthUser(c) as JWTPayload | undefined;
	const userId = user?.userId?.trim();
	return userId ? userId : undefined;
}

function resolveProjectImagePageIndex(state: { pages?: ProjectState["pages"] }, imageId: string | undefined): number | undefined {
	if (!imageId) return undefined;
	for (const [pageIndex, page] of (state.pages ?? []).entries()) {
		if (page.imageId === imageId || page.edits?.imageId === imageId) return pageIndex;
		if (page.imageLayers?.some((layer) => layer.imageId === imageId || layer.restoreImageId === imageId)) {
			return pageIndex;
		}
	}
	return undefined;
}

async function checkProjectAccess(
	c: any,
	projectId: string,
	permission = "read:project",
	options: { language?: string; pageIndex?: number; imageId?: string; taskType?: WorkflowTaskType } = {},
): Promise<Response | null> {
	// Catalog-authoritative, tombstone-aware read: under Postgres the catalog row
	// wins; a permanently-deleted project must not re-enable AI operations even if a
	// stale state.json survived a partial delete.
	const state = await resolveProjectState(projectId);
	if (!state) {
		return c.json({ error: "Project not found" }, 404);
	}
	const user = getAuthUser(c) as JWTPayload | undefined;
	const pageIndex = options.pageIndex ?? resolveProjectImagePageIndex(state, options.imageId);
	const decision = await resolveAiProjectAccess({
		stateUserId: state.userId,
		stateWorkspaceId: state.workspaceId?.trim(),
		user,
		permission,
		language: options.language,
		pageIndex,
		taskType: options.taskType,
		catalogCanAccess: user && projectCatalogStore
			? (() => {
				const catalog = projectCatalogStore;
				const authedUser = user;
				return ({ language, pageIndex, taskType }) => catalog.canAccessProject({
					projectId,
					userId: authedUser.userId,
					permission,
					language,
					pageIndex,
					taskType,
				});
			})()
			: undefined,
	});
	if (decision === "allowed") return null;
	if (decision === "unauthorized") return c.json({ error: "Unauthorized" }, 401);
	if (decision === "forbidden") return c.json({ error: `Forbidden: Missing permission '${permission}'` }, 403);
	return c.json({ error: "Project not found" }, 404);
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

	if (route.adapter === "sfx") {
		const providers = listAvailableSfxProviders(config);
		if (providers.length > 0) return null;
		return {
			error: "SFX Pro is not available. Enable the Python worker provider or configure an SFX fallback.",
			reason: "sfx_provider_unavailable",
			provider: route.providerHint,
		};
	}

	if (route.adapter === "openai-image") {
		if (isProviderKilled(config, route.providerHint)) {
			return {
				error: `${route.label} provider (${route.providerHint}) is disabled.`,
				reason: "provider_disabled",
				provider: route.providerHint,
			};
		}

		if (!config.openaiImagesEnabled || !process.env.OPENAI_API_KEY) {
			return {
				error: `${route.label} requires OpenAI image generation to be enabled with an API key.`,
				reason: "openai_images_not_configured",
				provider: route.providerHint,
			};
		}

		return null;
	}

	if (isProviderKilled(config, route.providerHint)) {
		return {
			error: `${route.label} provider (${route.providerHint}) is disabled.`,
			reason: "provider_disabled",
			provider: route.providerHint,
		};
	}

	if (!config.openrouterEnabled || !config.openrouterApiKey) {
		return {
			error: `${route.label} requires OpenRouter to be enabled with an API key.`,
			reason: "openrouter_not_configured",
			provider: route.providerHint,
		};
	}

	return null;
}

type PythonWorkerFailureReason = "sfx_worker_unreachable" | "sfx_worker_no_available_accounts";

async function checkPythonWorkerProvider(): Promise<{
	healthy: boolean;
	message: string;
	reason?: PythonWorkerFailureReason;
}> {
	const workerUrl = process.env.WORKER_URL || "http://localhost:8001";
	try {
		const response = await fetch(`${workerUrl}/health`, {
			signal: AbortSignal.timeout(1500),
		});
		if (!response.ok) {
			return {
				healthy: false,
				message: `Worker health returned ${response.status}`,
				reason: "sfx_worker_unreachable",
			};
		}
		const body = await response.json().catch(() => null) as {
			ok?: unknown;
			accounts_available?: unknown;
			error?: unknown;
			message?: unknown;
		} | null;
		const rawAvailable = body?.accounts_available;
		const availableAccounts = rawAvailable === undefined ? null : Number(rawAvailable);
		if (body?.ok === false) {
			return {
				healthy: false,
				message: typeof body.error === "string"
					? body.error
					: typeof body.message === "string"
						? body.message
						: "Worker reported unhealthy",
				reason: availableAccounts !== null && Number.isFinite(availableAccounts) && availableAccounts <= 0
					? "sfx_worker_no_available_accounts"
					: "sfx_worker_unreachable",
			};
		}
		if (availableAccounts !== null && Number.isFinite(availableAccounts) && availableAccounts <= 0) {
			return {
				healthy: false,
				message: "Worker has no available SFX accounts",
				reason: "sfx_worker_no_available_accounts",
			};
		}
		return {
			healthy: true,
			message: "Worker responding",
		};
	} catch {
		return {
			healthy: false,
			message: "Worker unreachable",
			reason: "sfx_worker_unreachable",
		};
	}
}

async function resolveSfxCapability(config: ReturnType<typeof loadConfig>): Promise<{
	available: boolean;
	reason: string | null;
	provider: string;
	detail: string;
}> {
	// SFX availability mirrors the router/submit gating: `disabled` blocks; otherwise
	// it defers to the official-default candidates (so AI_DEFAULT_PROVIDER is honored)
	// unless pinned. The legacy python-worker still needs a live health check below.
	if (isSfxDisabled(config)) {
		return {
			available: false,
			reason: "sfx_provider_disabled",
			provider: "openai-gpt-image-2",
			detail: "SFX Pro is disabled by the SFX provider mode.",
		};
	}
	const providers = resolveSfxTierDispatchProviders(config);
	if (!providers.length) {
		// Surface the configured-default provider's specific reason (e.g. OpenAI not
		// configured) so the panel/translate error matches the official-tier wording,
		// rather than a generic "sfx unavailable".
		const pin = resolveSfxPinnedProvider(config);
		if (pin === SFX_WORKER_PROVIDER_ID && !canUseSfxProvider(config, SFX_WORKER_PROVIDER_ID)) {
			return {
				available: false,
				reason: "sfx_provider_unavailable",
				provider: "python-worker",
				detail: "SFX Pro is pinned to the Python worker, which is not available (AI_PYTHON_ENABLED off or killed).",
			};
		}
		const primary = resolveOfficialProviderCandidates(config)[0];
		const reason = primary?.reason ?? "sfx_provider_unavailable";
		return {
			available: false,
			reason,
			provider: primary?.providerId ?? "openai-gpt-image-2",
			detail: reason === "provider_disabled"
				? "SFX Pro provider is disabled by kill switch."
				: reason === "openrouter_not_configured"
					? "SFX Pro is not available. Enable OpenRouter with an API key (or OpenAI image generation)."
					: "SFX Pro is not available. Enable OpenAI image generation with an API key (or OpenRouter as fallback).",
		};
	}

	let workerFailure: string | null = null;
	let workerFailureReason: PythonWorkerFailureReason = "sfx_worker_unreachable";
	for (const provider of providers) {
		if (provider === "python-worker") {
			const health = await checkPythonWorkerProvider();
			if (health.healthy) {
				return {
					available: true,
					reason: null,
					provider,
					detail: "SFX Pro ready via python-worker.",
				};
			}
			workerFailure = health.message;
			workerFailureReason = health.reason ?? "sfx_worker_unreachable";
			continue;
		}
		return {
			available: true,
			reason: null,
			provider,
			detail: `SFX Pro ready via ${provider}.`,
		};
	}

	return {
		available: false,
		reason: workerFailureReason,
		provider: "python-worker",
		detail: `SFX Pro is not available: ${workerFailure ?? "Python worker is not healthy"}.`,
	};
}

// ── Routes ───────────────────────────────────────────────────

// Submit AI translation job
ai.post("/translate", async (c) => {
	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = translateSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}
	const { projectId, imageId, crop, lang, customPrompt, textLayers, tier, quality } = parsed.data;
	const translateSfx = tier === "sfx-pro" ? parsed.data.translateSfx : false;

	// Validate IDs to prevent path traversal
	if (!isValidProjectId(projectId)) {
		return c.json({ error: "Invalid project ID format" }, 400);
	}
	if (!isValidImageId(imageId)) {
		return c.json({ error: "Invalid image ID format" }, 400);
	}
	const accessError = await checkProjectAccess(c, projectId, "generate:ai", { language: lang, imageId });
	if (accessError) return accessError;

	try {
		const result = await runWithLedgerActor(resolveLedgerActorUserId(c), () => submitAiJob({
			projectId,
			imageId,
			crop,
			lang,
			customPrompt,
			textLayers,
			translateSfx,
			tier: tier as AiTier,
			quality,
		}, {
			idempotencyKey: c.req.header("Idempotency-Key"),
			actorUserId: resolveLedgerActorUserId(c),
		}));
		return c.json(stripInternalPrompt(result));
	} catch (error) {
		if (error instanceof AiJobSubmissionError) {
			if (error.retryAfter) c.header("Retry-After", String(error.retryAfter));
			return c.json(error.body, error.status as any);
		}
		throw error;
	}
});

ai.get("/models", (c) => {
	const task = parseByoTaskType(c.req.query("task"));
	if (!task) return c.json({ error: "Invalid task", code: "invalid_task" }, 400);
	const provider = parseByoProvider(c.req.query("provider"));
	if (provider === null) return c.json({ error: "Invalid provider", code: "invalid_provider" }, 400);
	const providers: ByoProvider[] = provider ? [provider] : ["openai", "openrouter"];
	// Global model catalog keyed only by the task/provider query (no user/workspace input
	// to modelsForTask) — cacheable by anyone; the query string is part of the cache key.
	c.header("Cache-Control", "public, max-age=300");
	return c.json({
		task,
		formatLocked: true,
		providers: providers.map((item) => ({
			provider: item,
			models: byoApiService.modelsForTask(item, task),
		})),
	});
});

ai.get("/usage/:projectId", async (c) => {
	const projectId = c.req.param("projectId");
	if (!isValidProjectId(projectId)) {
		return c.json({ error: "Invalid project ID format" }, 400);
	}
	const accessError = await checkProjectAccess(c, projectId);
	if (accessError) return accessError;
	return c.json({ usage: await summarizeWorkspaceUsage(projectId) });
});

ai.get("/capabilities", async (c) => {
	const config = loadConfig();
	const projectId = c.req.query("projectId");
	const language = c.req.query("lang") || undefined;
	const imageId = c.req.query("imageId") || undefined;
	const pageIndexRaw = c.req.query("pageIndex");
	const pageIndex = pageIndexRaw === undefined
		? undefined
		: /^\d+$/.test(pageIndexRaw) && Number.isSafeInteger(Number(pageIndexRaw))
			? Number(pageIndexRaw)
			: null;
	// The panel charges the user-SELECTED quality (assertAiQualityAllowedForProject
	// enforces it on generate), not the tier default. Accept that selected quality
	// here so each tier's `available`/lock state matches what generate will actually
	// do — no "พร้อม" that then 402s, and no false lock on a tier the user could run
	// at an allowed quality. Absent/invalid → fall back to the tier default below.
	const selectedQualityRaw = c.req.query("quality");
	const isValidQuality = (value: string): value is AiImageQuality => value === "low" || value === "medium" || value === "high";
	if (selectedQualityRaw !== undefined && !isValidQuality(selectedQualityRaw)) {
		return c.json({ error: "Invalid quality" }, 400);
	}
	const selectedQuality: AiImageQuality | undefined = selectedQualityRaw !== undefined && isValidQuality(selectedQualityRaw)
		? selectedQualityRaw
		: undefined;
	const isProjectScoped = Boolean(projectId);
	if (projectId) {
		if (!isValidProjectId(projectId)) return c.json({ error: "Invalid project ID format" }, 400);
		if (imageId && !isValidImageId(imageId)) return c.json({ error: "Invalid image ID format" }, 400);
		if (pageIndex === null) return c.json({ error: "Invalid pageIndex" }, 400);
		const accessError = await checkProjectAccess(c, projectId, "generate:ai", { language, imageId, pageIndex });
		if (accessError) return accessError;
	}
	const plan = projectId ? resolveWorkspacePlan(await resolveAiJobPlanId(projectId)) : null;
	// A Studio workspace with an active BYO key satisfies provider availability even
	// when platform OpenAI/OpenRouter is unconfigured (submitAiJob accepts the job
	// on the customer's own key). Mirror that here so the panel does not tell the
	// user the tier is unavailable for a job the backend would actually run.
	let hasByoRoute = false;
	if (projectId) {
		const workspaceId = await resolveWorkspaceIdForProject(projectId);
		hasByoRoute = workspaceId ? Boolean(await byoApiService.getWorkspaceByoProvider(workspaceId)) : false;
	}
	const tiers: AiTier[] = ["sfx-pro", "clean-pro", "budget-clean"];
	const capabilities = await Promise.all(tiers.map(async (tier) => {
		const route = resolveAiTierProviderRoute(tier);
		// Gate against the quality that will actually be CHARGED on generate: the
		// user-selected quality when supplied, otherwise the tier default. This keeps
		// the panel's availability/lock state in lockstep with
		// assertAiQualityAllowedForProject so a Free user never sees "พร้อม" then a 402,
		// and a tier the user could run at an allowed quality isn't shown as locked.
		const quality = resolveAiJobQuality(tier, selectedQuality);
		const planAllowed = !plan || workspacePlanAllowsAiQuality(plan.id, quality);
		if (route.sfxControlled) {
			const sfx = await resolveSfxCapability(config);
			// SFX availability is governed by the SFX controls (sfxProviderMode /
			// per-provider kill switch / `disabled`), which resolve to the official
			// OpenAI/OpenRouter adapters (or the dormant worker). A BYO key is a
			// separate path; leave SFX availability driven by the SFX controls.
			return {
				id: tier,
				label: route.label,
				provider: sfx.provider,
				quality,
				available: sfx.available && planAllowed,
				reason: planAllowed ? sfx.reason : "ai_quality_not_allowed",
				detail: planAllowed ? sfx.detail : `${route.label} requires ${quality} quality, which is not included in the ${plan?.name} plan.`,
			};
		}
		const unavailable = hasByoRoute ? null : providerUnavailable(config, tier);
		return {
			id: tier,
			label: route.label,
			provider: route.providerHint,
			quality,
			available: unavailable === null && planAllowed,
			reason: planAllowed ? unavailable?.reason ?? null : "ai_quality_not_allowed",
			detail: planAllowed
				? unavailable?.error ?? (hasByoRoute ? `${route.label} ready via your workspace API key (BYO).` : `${route.label} ready via ${route.providerHint}.`)
				: `${route.label} requires ${quality} quality, which is not included in the ${plan?.name} plan.`,
		};
	}));
	return c.json({
		planScoped: isProjectScoped,
		plan: plan ? {
			scope: "project",
			projectId,
			id: plan.id,
			name: plan.name,
			allowedAiQualities: plan.allowedAiQualities,
		} : null,
		tiers: capabilities,
	});
});

// Check job status
ai.post("/status/:jobId/cancel", async (c) => {
	const jobId = c.req.param("jobId");
	const job = await jobQueue.get(jobId);
	if (!job) return c.json({ error: "Job not found" }, 404);

	const accessError = await checkProjectAccess(c, job.projectId, "generate:ai", { language: job.lang, imageId: job.imageId });
	if (accessError) return accessError;

	const cancelled = await jobQueue.cancel(jobId);
	const current = await jobQueue.get(jobId) ?? job;
	if (!cancelled) {
		return c.json({
			error: `AI job cannot be cancelled from ${current.status}`,
			status: current.status,
			events: await jobQueue.eventsFor(jobId),
		}, 409);
	}

	return c.json({
		ok: true,
		status: current.status,
		tier: current.tier ?? "sfx-pro",
		quality: current.quality,
		costEstimate: current.costEstimate,
		creditReservation: current.creditReservation,
		error: current.error,
		events: await jobQueue.eventsFor(jobId),
	});
});

ai.post("/status/:jobId/retry", async (c) => {
	const jobId = c.req.param("jobId");
	const job = await jobQueue.get(jobId);
	if (!job) return c.json({ error: "Job not found" }, 404);
	const accessError = await checkProjectAccess(c, job.projectId, "generate:ai", { language: job.lang, imageId: job.imageId });
	if (accessError) return accessError;
	if (!isRetriableJob(job)) {
		return c.json({
			error: job.retryable === false
				? `AI job cannot be retried because the last failure is non-retriable`
				: `AI job cannot be retried from ${job.status}`,
			status: job.status,
			retryable: job.retryable,
			failureCode: job.failureCode,
			retryAfter: job.retryAfterSeconds,
			events: await jobQueue.eventsFor(jobId),
		}, 409);
	}

	let retryJob;
	const actorUserId = resolveLedgerActorUserId(c);
	try {
		await assertRetryAssetReadyForAi(job.projectId, job.imageId);
		const retryIdempotencyKey = c.req.header("Idempotency-Key") || `retry:${job.jobId}`;
		const existingRetryJob = await jobQueue.getByIdempotencyKey(retryIdempotencyKey);
		if (existingRetryJob) {
			retryJob = await runWithLedgerActor(actorUserId, () => jobQueue.retry(jobId, { idempotencyKey: retryIdempotencyKey }));
		} else {
			const admissionLimits = await resolveAiJobAdmissionLimits(job.projectId);
			const retryCostEstimate = await estimateAiJobSubmissionCost({
				projectId: job.projectId,
				imageId: job.imageId,
				crop: job.crop,
				tier: job.tier ?? "sfx-pro",
				quality: job.quality,
				prompt: job.prompt,
			});
			await assertAiQualityAllowedForProject(
				job.projectId,
				retryCostEstimate.quality ?? resolveAiJobQuality(job.tier ?? "sfx-pro", job.quality),
			);
			retryJob = await runWithLedgerActor(actorUserId, () => jobQueue.retry(jobId, {
				idempotencyKey: retryIdempotencyKey,
				admissionLimits,
				costEstimate: retryCostEstimate,
			}));
		}
	} catch (error) {
		if (error instanceof AiJobSubmissionError) {
			if (error.retryAfter) c.header("Retry-After", String(error.retryAfter));
			return c.json(error.body, error.status as any);
		}
		if (error instanceof QueueAdmissionError) {
			const status = error.admission.reason === "queue_draining" ? 503 : 429;
			c.header("Retry-After", String(error.admission.retryAfterSeconds));
			return c.json({
				error: error.message,
				code: status === 503 ? "ai_queue_draining" : "ai_queue_capacity_exceeded",
				reason: error.admission.reason,
				retryAfter: error.admission.retryAfterSeconds,
				queue: {
					snapshot: error.admission.snapshot,
					limits: error.admission.limits,
				},
			}, status as any);
		}
		if (error instanceof UsageQuotaExceededError) {
			return c.json({
				error: "Workspace usage quota exceeded",
				code: error.code,
				reason: error.reason,
				attempted: error.attempted,
				usage: error.summary,
			}, 402);
		}
		if (error instanceof QueueIdempotencyConflictError) {
			return c.json({
				error: error.message,
				code: "ai_retry_idempotency_conflict",
			}, 409);
		}
		// A retry re-charges the personal/shareable credit buckets; surface an
		// insufficient-credit failure to the caller instead of a 500.
		if (error instanceof CreditServiceError) {
			return c.json({ error: error.message, code: error.code }, error.status as any);
		}
		throw error;
	}
	if (!retryJob) {
		return c.json({
			error: job.retryable === false
				? `AI job cannot be retried because the last failure is non-retriable`
				: `AI job cannot be retried from ${job.status}`,
			status: job.status,
			retryable: job.retryable,
			failureCode: job.failureCode,
			retryAfter: job.retryAfterSeconds,
			events: await jobQueue.eventsFor(jobId),
		}, 409);
	}

	return c.json({
		ok: true,
		jobId: retryJob.jobId,
		status: retryJob.status,
		tier: retryJob.tier ?? "sfx-pro",
		quality: retryJob.quality,
		costEstimate: retryJob.costEstimate,
		creditReservation: retryJob.creditReservation,
		events: await jobQueue.eventsFor(retryJob.jobId),
		sourceEvents: await jobQueue.eventsFor(jobId),
	});
});

ai.get("/status/:jobId", async (c) => {
	const jobId = c.req.param("jobId");
	const job = await jobQueue.get(jobId);
	if (!job) return c.json({ error: "Job not found" }, 404);
	const accessError = await checkProjectAccess(c, job.projectId, "read:project", { language: job.lang, imageId: job.imageId });
	if (accessError) return accessError;
	const clientStatus = job.status === "blocked" ? "error" : job.status;
	return c.json({
		status: clientStatus,
		queueStatus: job.status,
		blocked: job.status === "blocked",
		tier: job.tier ?? "sfx-pro",
		quality: job.quality,
		costEstimate: job.costEstimate,
		creditReservation: job.creditReservation,
		resultImageId: job.resultImageId,
		error: job.error,
		retryable: job.retryable,
		failureCode: job.failureCode,
		retryAfter: job.retryAfterSeconds,
		events: await jobQueue.eventsFor(jobId),
	});
});

// Admin: get config (mask API key)
ai.get("/admin/config", requireAdmin, (c) => {
	const config = loadConfig();
	return c.json({
		...config,
		openrouterApiKey: config.openrouterApiKey ? "••••••••" : "",
	});
});

// Admin: update config
ai.post("/admin/config", requireAdmin, async (c) => {
	const body = await readJsonBody(c);
	if (!body.ok) return body.response;
	const parsed = configUpdateSchema.safeParse(body.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	const config = loadConfig();
	const update = parsed.data;

	// Reject an unsupported image model at the API boundary with a clear 400 rather
	// than persisting it (a bad value would otherwise make every subsequent
	// loadConfig() throw and break all AI image jobs).
	if (update.openaiImageModel !== undefined && !isSupportedOpenAiImageModel(update.openaiImageModel)) {
		return c.json(
			{ error: `openaiImageModel must be one of: ${OPENAI_IMAGE_MODELS.join(", ")}` },
			400,
		);
	}

	// Reject an unsupported support-agent model at the boundary with a clear 400.
	// The provider may also be changing in the same update, so validate the model
	// against whichever provider will be in effect after this update is applied.
	if (update.supportAgentProvider !== undefined || update.supportAgentModel !== undefined) {
		const nextProvider = update.supportAgentProvider ?? config.supportAgentProvider;
		try {
			resolveSupportAgentModel(nextProvider, update.supportAgentModel ?? config.supportAgentModel);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Invalid support agent model" }, 400);
		}
	}

	if (update.openrouterEnabled !== undefined) config.openrouterEnabled = update.openrouterEnabled;
	if (update.openrouterApiKey !== undefined) config.openrouterApiKey = update.openrouterApiKey;
	if (update.openaiImagesEnabled !== undefined) config.openaiImagesEnabled = update.openaiImagesEnabled;
	if (update.openaiImageModel !== undefined) config.openaiImageModel = update.openaiImageModel;
	if (update.openaiImageDefaultQuality !== undefined) config.openaiImageDefaultQuality = update.openaiImageDefaultQuality;
	if (update.chatgptEnabled !== undefined) config.chatgptEnabled = update.chatgptEnabled;
	if (update.primaryBackend !== undefined) config.primaryBackend = update.primaryBackend;
	if (update.providerKillSwitches !== undefined) {
		config.providerKillSwitches = { ...config.providerKillSwitches, ...update.providerKillSwitches };
	}
	if (update.sfxProviderMode !== undefined) config.sfxProviderMode = update.sfxProviderMode;
	if (update.promptModerationEnabled !== undefined) config.promptModerationEnabled = update.promptModerationEnabled;
	if (update.imageModerationEnabled !== undefined) config.imageModerationEnabled = update.imageModerationEnabled;
	if (update.aiSupportEnabled !== undefined) config.aiSupportEnabled = update.aiSupportEnabled;
	if (update.supportAgentProvider !== undefined) config.supportAgentProvider = update.supportAgentProvider;
	if (update.supportAgentModel !== undefined) {
		config.supportAgentModel = resolveSupportAgentModel(config.supportAgentProvider, update.supportAgentModel);
	}

	saveConfig(config);
	return c.json({ ok: true });
});

export { ai };
