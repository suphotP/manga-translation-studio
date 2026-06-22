// Stream C PR-2: per-language AI jobs (backend).
//
// Covers the four money-/correctness-sensitive guarantees:
//   1. A submitted AI job persists its target language (`AiJob.lang`) through the
//      queue snapshot store (the source of truth for active jobs — memory/file/redis
//      all serialize the full job, so `lang` survives a reload). The relational
//      `ai_jobs.target_lang` column + backfill are asserted in migrations.test.ts.
//   2. Two languages on the same page/region produce two markers in DISTINCT
//      per-language buckets and never overwrite each other.
//   3. An omitted language maps to the project's default-language bucket, and the
//      page's flat (legacy) output is returned unchanged for the default track.
//   4. Idempotency de-dupes per (job, lang): the same crop/prompt/tier for a
//      DIFFERENT language is a fresh job (fresh admission + reservation, not a
//      collapsed reuse), while a true resubmit for the SAME language is reused.

import { describe, test, expect, mock } from "bun:test";
import { join } from "path";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { v4 as uuid } from "uuid";
import type { AiJob, AiReviewMarker, PageState, ProjectState } from "../types/index.js";
import {
	createAiReviewMarker,
	normalizeAiReviewMarkers,
} from "../services/ai-review-markers.js";
import {
	aiReviewMarkersForLang,
	groupAiReviewMarkersByLang,
	pageLanguageOutput,
	resolveAiReviewMarkerLang,
	resolveProjectDefaultLang,
} from "../services/project-catalog.js";

function makeMarker(overrides: Partial<Parameters<typeof createAiReviewMarker>[0]> = {}) {
	return createAiReviewMarker({
		jobId: uuid(),
		pageIndex: 0,
		imageId: "page-0.png",
		region: { x: 0, y: 0, w: 32, h: 32 },
		tier: "sfx-pro",
		...overrides,
	});
}

function makeProjectState(markers: AiReviewMarker[], targetLang = "th"): ProjectState {
	return {
		projectId: uuid(),
		userId: "tester",
		name: "Stream C fixture",
		createdAt: new Date().toISOString(),
		pages: [],
		currentPage: 0,
		targetLang,
		aiReviewMarkers: markers,
	};
}

describe("per-language AI review marker buckets", () => {
	test("two languages on the same page/region live in distinct buckets and never overwrite", () => {
		const en = makeMarker({ targetLang: "en", resultImageId: "result-en.png" });
		const ja = makeMarker({ targetLang: "ja", resultImageId: "result-ja.png" });
		const state = makeProjectState([en, ja], "th");
		normalizeAiReviewMarkers(state);

		const buckets = groupAiReviewMarkersByLang(state);
		expect(Object.keys(buckets).sort()).toEqual(["en", "ja"]);
		expect(buckets.en).toHaveLength(1);
		expect(buckets.ja).toHaveLength(1);
		// Distinct results — the second language did NOT clobber the first.
		expect(buckets.en[0].resultImageId).toBe("result-en.png");
		expect(buckets.ja[0].resultImageId).toBe("result-ja.png");
		expect(buckets.en[0].id).not.toBe(buckets.ja[0].id);

		expect(aiReviewMarkersForLang(state, "en").map((m) => m.id)).toEqual([en.id]);
		expect(aiReviewMarkersForLang(state, "ja").map((m) => m.id)).toEqual([ja.id]);
	});

	test("a legacy marker without targetLang maps to the project default bucket", () => {
		const legacy = makeMarker({ resultImageId: "legacy.png" }); // no targetLang
		const tagged = makeMarker({ targetLang: "en", resultImageId: "en.png" });
		const state = makeProjectState([legacy, tagged], "th");
		normalizeAiReviewMarkers(state);

		expect(legacy.targetLang).toBeUndefined();
		expect(resolveAiReviewMarkerLang(legacy, resolveProjectDefaultLang(state))).toBe("th");

		const buckets = groupAiReviewMarkersByLang(state);
		expect(buckets.th.map((m) => m.id)).toEqual([legacy.id]);
		expect(buckets.en.map((m) => m.id)).toEqual([tagged.id]);

		// Querying the default bucket (or omitting lang) returns the legacy marker.
		expect(aiReviewMarkersForLang(state).map((m) => m.id)).toEqual([legacy.id]);
		expect(aiReviewMarkersForLang(state, "th").map((m) => m.id)).toEqual([legacy.id]);
	});

	test("a marker explicitly tagged with the project default shares the legacy bucket", () => {
		const legacy = makeMarker({ resultImageId: "legacy.png" });
		const explicitDefault = makeMarker({ targetLang: "TH", resultImageId: "explicit.png" }); // case-insensitive
		const state = makeProjectState([legacy, explicitDefault], "th");
		normalizeAiReviewMarkers(state);

		// Normalization lowercases the explicit lang so it collapses into "th".
		expect(explicitDefault.targetLang).toBe("th");
		const buckets = groupAiReviewMarkersByLang(state);
		expect(Object.keys(buckets)).toEqual(["th"]);
		expect(buckets.th.map((m) => m.id).sort()).toEqual([legacy.id, explicitDefault.id].sort());
	});
});

describe("per-language page output backfill", () => {
	const page: PageState = {
		imageId: "page-0.png",
		imageName: "page-0.png",
		textLayers: [{ id: "t1", text: "default-track text" } as any],
		translationHandoff: { status: "submitted" } as any,
		qcHandoff: { status: "approved" } as any,
		cleaningHandoff: { status: "submitted" } as any, // shared raster — NOT per-lang
		pendingAiJobs: [],
		coverRect: null,
	};

	test("omitted/default language returns the flat (legacy) page output unchanged", () => {
		const out = pageLanguageOutput(page, "th", "th");
		expect(out.textLayers).toBe(page.textLayers);
		expect(out.translationHandoff).toBe(page.translationHandoff);
		expect(out.qcHandoff).toBe(page.qcHandoff);
		// Cleaning is intentionally absent from the per-language slice.
		expect("cleaningHandoff" in out).toBe(false);
	});

	test("a non-default language with no stored bucket has empty output (no flat leakage)", () => {
		const out = pageLanguageOutput(page, "en", "th");
		expect(out.textLayers).toEqual([]);
		expect(out.translationHandoff).toBeUndefined();
	});

	test("a stored per-language bucket is returned for that language", () => {
		const withBucket: PageState = {
			...page,
			languageOutputs: {
				en: { textLayers: [{ id: "e1", text: "english text" } as any], qcHandoff: { status: "in_progress" } as any },
			},
		};
		const out = pageLanguageOutput(withBucket, "en", "th");
		expect(out.textLayers).toHaveLength(1);
		expect((out.textLayers[0] as any).text).toBe("english text");
		// Default track still reads the flat fields.
		expect(pageLanguageOutput(withBucket, "th", "th").textLayers).toBe(page.textLayers);
	});
});

describe("submitAiJob persists target language + per-language idempotency", () => {
	// Modeled on the proven ai-services warned-prompt submission test: sfx-pro tier
	// with OpenAI image generation enabled makes a provider available, moderation is
	// DISABLED so the job lands as `pending` and stays queued for read-back.
	async function withSubmissionFixture<T>(
		run: (ctx: {
			projectId: string;
			imageId: string;
			submitAiJob: typeof import("../services/ai-job-submission.js").submitAiJob;
			jobQueue: typeof import("../services/queue.js").jobQueue;
		}) => Promise<T>,
	): Promise<T> {
		const sharp = (await import("sharp")).default;
		const { DATA_DIR, PROJECTS_DIR, loadConfig, saveConfig, serverConfig } = await import("../config.js");
		const { objectStorage } = await import("../services/storage.js");
		const { submitAiJob } = await import("../services/ai-job-submission.js");
		const { jobQueue } = await import("../services/queue.js");

		const previousOpenAiKey = process.env.OPENAI_API_KEY;
		const previousFetch = globalThis.fetch;
		// Keep usage-quota enforcement ON (so each per-language job is genuinely
		// admission/reservation-checked and neither skips the ledger) but give enough
		// monthly headroom for the handful of jobs this test queues — otherwise the
		// tiny free-plan AI credit limit rejects the second per-language reservation,
		// which is exactly the per-(project,lang) charge we want to PROVE happens.
		const previousMonthlyLimit = process.env.USAGE_MONTHLY_AI_CREDIT_THB;
		process.env.USAGE_MONTHLY_AI_CREDIT_THB = "100000";
		const originalConfig = loadConfig();
		const configPath = join(DATA_DIR, "config.json");
		const originalConfigFile = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;
		const serverSnapshot = { aiRequireAssetRegistryForAi: serverConfig.aiRequireAssetRegistryForAi };

		const projectId = uuid();
		const imageId = `${uuid()}.png`;
		const projectPath = join(PROJECTS_DIR, projectId);
		const source = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ffffff" } }).png().toBuffer();

		try {
			// A prior test file may have repointed/removed DATA_DIR (config paths are
			// resolved at import time), so re-materialize the dirs before writing config
			// or project images — keeps this fixture hermetic regardless of file order.
			mkdirSync(DATA_DIR, { recursive: true });
			mkdirSync(PROJECTS_DIR, { recursive: true });
			Object.assign(serverConfig as unknown as Record<string, unknown>, { aiRequireAssetRegistryForAi: false });
			saveConfig({
				...originalConfig,
				openaiImagesEnabled: true,
				openaiImageModel: "gpt-image-1",
				openaiImageDefaultQuality: "low",
				promptModerationEnabled: false, // land directly in `pending`
				providerKillSwitches: {},
			});
			process.env.OPENAI_API_KEY = "sk-test";
			// No network is needed at submission time once moderation is off; fail loud
			// if anything tries to fetch so the test stays hermetic.
			globalThis.fetch = mock(async (url: string) => {
				throw new Error(`Unexpected fetch during submission: ${url}`);
			}) as any;
			await objectStorage.putProjectImage({ projectId, imageId, buffer: source });
			return await run({ projectId, imageId, submitAiJob, jobQueue });
		} finally {
			Object.assign(serverConfig as unknown as Record<string, unknown>, serverSnapshot);
			if (originalConfigFile === null) {
				if (existsSync(configPath)) unlinkSync(configPath);
			} else {
				writeFileSync(configPath, originalConfigFile);
			}
			if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previousOpenAiKey;
			if (previousMonthlyLimit === undefined) delete process.env.USAGE_MONTHLY_AI_CREDIT_THB;
			else process.env.USAGE_MONTHLY_AI_CREDIT_THB = previousMonthlyLimit;
			globalThis.fetch = previousFetch;
			rmSync(projectPath, { recursive: true, force: true });
		}
	}

	test("a queued job persists its target language and reads it back", async () => {
		await withSubmissionFixture(async ({ projectId, imageId, submitAiJob, jobQueue }) => {
			const submitted = await submitAiJob({
				projectId,
				imageId,
				crop: { x: 0, y: 0, w: 32, h: 32 },
				lang: "en",
				tier: "sfx-pro",
				quality: "low",
			}, { idempotencyKey: `lang-en-${projectId}` });

			const queued = await jobQueue.get(submitted.jobId);
			expect(queued?.lang).toBe("en");
			expect(queued?.status).toBe("pending");
		});
	});

	test("the same crop/prompt for a DIFFERENT language is a distinct job; same language reuses", async () => {
		await withSubmissionFixture(async ({ projectId, imageId, submitAiJob, jobQueue }) => {
			const crop = { x: 0, y: 0, w: 32, h: 32 };

			// No explicit idempotency key → exercise the deterministic ai-submit digest,
			// which folds `lang` in. Two languages MUST yield two jobs (no collapse).
			const en = await submitAiJob({ projectId, imageId, crop, lang: "en", tier: "sfx-pro", quality: "low" });
			const ja = await submitAiJob({ projectId, imageId, crop, lang: "ja", tier: "sfx-pro", quality: "low" });
			expect(en.reused).toBe(false);
			expect(ja.reused).toBe(false);
			expect(ja.jobId).not.toBe(en.jobId);

			const enJob = await jobQueue.get(en.jobId);
			const jaJob = await jobQueue.get(ja.jobId);
			expect(enJob?.lang).toBe("en");
			expect(jaJob?.lang).toBe("ja");
			// Each per-language job carries its OWN credit reservation — neither skips
			// admission/reservation and neither double-charges (nor reuses) the other.
			expect(enJob?.idempotencyKey).not.toBe(jaJob?.idempotencyKey);
			expect(enJob?.creditReservation?.status).toBe("reserved");
			expect(jaJob?.creditReservation?.status).toBe("reserved");

			// A true resubmit for the SAME language de-dupes to the existing job
			// (no second reservation, no second charge).
			const enAgain = await submitAiJob({ projectId, imageId, crop, lang: "en", tier: "sfx-pro", quality: "low" });
			expect(enAgain.reused).toBe(true);
			expect(enAgain.jobId).toBe(en.jobId);
		});
	});

	test("an explicit Idempotency-Key reused with a DIFFERENT payload returns 409, not the stale job", async () => {
		await withSubmissionFixture(async ({ projectId, imageId, submitAiJob, jobQueue }) => {
			const sharedKey = `explicit-${projectId}`;
			const first = await submitAiJob({
				projectId,
				imageId,
				crop: { x: 0, y: 0, w: 32, h: 32 },
				lang: "en",
				tier: "sfx-pro",
				quality: "low",
			}, { idempotencyKey: sharedKey });
			expect(first.reused).toBe(false);

			// Same explicit key, IDENTICAL payload → legitimate idempotent reuse.
			const same = await submitAiJob({
				projectId,
				imageId,
				crop: { x: 0, y: 0, w: 32, h: 32 },
				lang: "en",
				tier: "sfx-pro",
				quality: "low",
			}, { idempotencyKey: sharedKey });
			expect(same.reused).toBe(true);
			expect(same.jobId).toBe(first.jobId);

			// Same explicit key, DIFFERENT payload (changed crop + lang) → 409 conflict
			// instead of silently returning the first job (and its stale charge).
			const { AiJobSubmissionError } = await import("../services/ai-job-submission.js");
			let thrown: unknown;
			try {
				await submitAiJob({
					projectId,
					imageId,
					crop: { x: 0, y: 0, w: 16, h: 16 },
					lang: "ja",
					tier: "sfx-pro",
					quality: "low",
				}, { idempotencyKey: sharedKey });
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(AiJobSubmissionError);
			expect((thrown as InstanceType<typeof AiJobSubmissionError>).status).toBe(409);
			expect((thrown as InstanceType<typeof AiJobSubmissionError>).body.code).toBe("idempotency_key_payload_mismatch");

			// The original job is untouched (no second job created under the key).
			const original = await jobQueue.get(first.jobId);
			expect(original?.lang).toBe("en");
		});
	});

	// ── Money/concurrency P1 regressions (codex audit) ───────────────────────────
	test("two concurrent same-idempotency-key submits debit credits + reserve usage EXACTLY ONCE (loser charged nothing)", async () => {
		await withSubmissionFixture(async ({ projectId, imageId, submitAiJob, jobQueue }) => {
			const { grantCredits, getBalance, hasCreditSystem } = await import("../services/credits.js");
			const { usageLedger } = await import("../services/usage-ledger.js");
			const userId = `user-${uuid()}`;
			// resolveCreditWorkspaceId falls back to projectId when no workspace state
			// exists, so grant to the projectId workspace + this user.
			await grantCredits({
				workspaceId: projectId,
				ownerScope: "workspace",
				ownerId: projectId,
				creditClass: "shareable",
				amount: 100_000,
				source: "goodwill",
			});
			expect(hasCreditSystem(projectId, userId)).toBe(true);
			const before = getBalance("member", userId, projectId);

			const input = {
				projectId,
				imageId,
				crop: { x: 0, y: 0, w: 32, h: 32 },
				lang: "en",
				tier: "sfx-pro" as const,
				quality: "low" as const,
			};
			const key = `concurrent-${projectId}`;

			// Fire SEVERAL DUPLICATE submits with the SAME explicit idempotency key
			// concurrently (more contenders → higher chance of the adverse interleave
			// where a loser reserved first). Exactly one must win and charge; every other
			// must de-dupe onto it having charged nothing.
			const results = await Promise.all(
				Array.from({ length: 5 }, () =>
					submitAiJob(input, { idempotencyKey: key, actorUserId: userId }),
				),
			);
			const a = results[0]!;

			// All resolve to the SAME job, exactly one is the fresh (non-reused) winner.
			const jobIds = new Set(results.map((r) => r.jobId));
			expect(jobIds.size).toBe(1);
			expect(results.filter((r) => r.reused === false)).toHaveLength(1);
			expect(results.filter((r) => r.reused === true)).toHaveLength(results.length - 1);

			// Credit bucket debited EXACTLY ONCE, the size-flat per-op CREDIT price
			// (creditUnits: low=1), NOT the THB reserve — the buckets are credit-unit
			// denominated. The separate usage-ledger reservation (asserted below) stays THB.
			const creditUnits = a.costEstimate?.creditUnits ?? 0;
			const reserveThb = a.costEstimate?.reserveThb ?? 0;
			expect(creditUnits).toBeGreaterThan(0);
			expect(reserveThb).toBeGreaterThan(0);
			const after = getBalance("member", userId, projectId);
			const debited = Math.round((before.total - after.total) * 10_000) / 10_000;
			expect(debited).toBe(creditUnits);

			// Usage ledger has EXACTLY ONE active reservation and NO leaked reservation
			// for any other (loser's) jobId.
			const reservations = usageLedger
				.listEvents()
				.filter((e) => e.workspaceId === projectId && e.kind === "ai_credit_reserved");
			expect(reservations).toHaveLength(1);
			expect(reservations[0]?.subjectId).toBe(a.jobId);

			const summary = usageLedger.summarize(projectId, projectId);
			expect(summary.monthly.aiActiveReservedThb).toBe(reserveThb);
		});
	});

	test("crash-after-charge-before-add: takeover releases the dead jobId's consumption + reservation, retry charges ONCE (money P1 #2)", async () => {
		const previousTimeout = process.env.AI_CLAIM_MATERIALIZE_TIMEOUT_MS;
		// Short materialize bound so the loser/taker times out fast instead of waiting 5s.
		process.env.AI_CLAIM_MATERIALIZE_TIMEOUT_MS = "60";
		try {
			await withSubmissionFixture(async ({ projectId, imageId, submitAiJob, jobQueue }) => {
				const { grantCredits, getBalance } = await import("../services/credits.js");
				const { usageLedger, reserveAiCredit } = await import("../services/usage-ledger.js");
				const { consume: consumeCredits } = await import("../services/credits.js");
				const userId = `user-${uuid()}`;
				await grantCredits({
					workspaceId: projectId,
					ownerScope: "workspace",
					ownerId: projectId,
					creditClass: "shareable",
					amount: 100_000,
					source: "goodwill",
				});
				const before = getBalance("member", userId, projectId);

				const input = {
					projectId,
					imageId,
					crop: { x: 0, y: 0, w: 32, h: 32 },
					lang: "en",
					tier: "sfx-pro" as const,
					quality: "low" as const,
				};
				const key = `crash-takeover-${projectId}`;

				// Simulate a WINNER that won the claim, CHARGED (consumed credits + reserved
				// usage keyed by ITS jobId), MARKED the claim charged, then CRASHED before
				// jobQueue.add — leaving an orphaned, charged claim and no queue job.
				const crashedJobId = uuid();
				const reserveThb = 36; // matches sfx-pro low cost (asserted below via the real charge)
				await jobQueue.claimIdempotency([key], crashedJobId);
				await consumeCredits(projectId, userId, reserveThb, "ai_job_submitted", crashedJobId);
				await reserveAiCredit({
					workspaceId: projectId,
					projectId,
					jobId: crashedJobId,
					amountThb: reserveThb,
					idempotencyKey: `ai-credit-reserve:${crashedJobId}`,
				});
				await jobQueue.markIdempotencyClaimCharged([key], crashedJobId);

				// Sanity: the crashed owner's charge is currently live (consumed + reserved).
				const midReservations = usageLedger
					.listEvents()
					.filter((e) => e.workspaceId === projectId && e.kind === "ai_credit_reserved");
				expect(midReservations.map((e) => e.subjectId)).toContain(crashedJobId);

				// A fresh submit with the SAME explicit key times out waiting for the dead
				// owner, TAKES OVER its stale charged claim (reconciling its billing), and
				// charges its own fresh job exactly once.
				const result = await submitAiJob(input, { idempotencyKey: key, actorUserId: userId });
				expect(result.reused).toBe(false);
				expect(result.jobId).not.toBe(crashedJobId);
				const realJob = await jobQueue.get(result.jobId);
				expect(realJob?.status).toBe("pending");

				// The crashed jobId's reservation is RELEASED (no leak): no active reservation
				// remains for it.
				const reservedStates = usageLedger.listEvents().filter((e) => e.workspaceId === projectId);
				const crashedReleased = reservedStates.some(
					(e) => e.subjectId === crashedJobId && e.kind === "ai_credit_released",
				);
				expect(crashedReleased).toBe(true);

				// Exactly ONE active reservation remains — the retry's — and it is the only
				// committed AI usage.
				const summary = usageLedger.summarize(projectId, projectId);
				const actualReserve = result.costEstimate?.reserveThb ?? 0;
				const retryCreditUnits = result.costEstimate?.creditUnits ?? 0;
				expect(actualReserve).toBeGreaterThan(0);
				expect(retryCreditUnits).toBeGreaterThan(0);
				expect(summary.monthly.aiActiveReservedThb).toBe(actualReserve);

				// The crashed owner's consumption (the simulated 36-credit debit) was fully
				// refunded AND the retry charged once: net credit debit equals exactly the
				// retry job's size-flat credit price (creditUnits), not two charges, not zero.
				const after = getBalance("member", userId, projectId);
				const debited = Math.round((before.total - after.total) * 10_000) / 10_000;
				expect(debited).toBe(retryCreditUnits);
			});
		} finally {
			if (previousTimeout === undefined) delete process.env.AI_CLAIM_MATERIALIZE_TIMEOUT_MS;
			else process.env.AI_CLAIM_MATERIALIZE_TIMEOUT_MS = previousTimeout;
		}
	});

	test("over-mark safety: claim flagged needs-reconcile but crashed BEFORE any billing write — takeover reconciles harmlessly (idempotent no-op), retry charges ONCE (money P1 #2)", async () => {
		const previousTimeout = process.env.AI_CLAIM_MATERIALIZE_TIMEOUT_MS;
		process.env.AI_CLAIM_MATERIALIZE_TIMEOUT_MS = "60";
		try {
			await withSubmissionFixture(async ({ projectId, imageId, submitAiJob, jobQueue }) => {
				const { grantCredits, getBalance } = await import("../services/credits.js");
				const { usageLedger } = await import("../services/usage-ledger.js");
				const userId = `user-${uuid()}`;
				await grantCredits({
					workspaceId: projectId,
					ownerScope: "workspace",
					ownerId: projectId,
					creditClass: "shareable",
					amount: 100_000,
					source: "goodwill",
				});
				const before = getBalance("member", userId, projectId);

				const input = {
					projectId,
					imageId,
					crop: { x: 0, y: 0, w: 32, h: 32 },
					lang: "en",
					tier: "sfx-pro" as const,
					quality: "low" as const,
				};
				const key = `crash-premark-${projectId}`;

				// Simulate the NEW order's earliest crash window: the owner won the claim and
				// FLAGGED it needs-reconcile (markIdempotencyClaimCharged BEFORE the first
				// billing write), then CRASHED before consumeCredits / reserveAiCredit ran.
				// The persisted claim reads charged:true even though NOTHING was billed.
				const crashedJobId = uuid();
				await jobQueue.claimIdempotency([key], crashedJobId);
				await jobQueue.markIdempotencyClaimCharged([key], crashedJobId);

				// No consumption, no reservation exists for the crashed jobId.
				const preReservations = usageLedger
					.listEvents()
					.filter((e) => e.workspaceId === projectId && e.subjectId === crashedJobId);
				expect(preReservations).toHaveLength(0);

				// A fresh submit times out, TAKES OVER the charged-but-unbilled stale claim,
				// runs reconcileStaleClaimBilling (idempotent no-op since nothing was written),
				// and charges its own fresh job exactly once.
				const result = await submitAiJob(input, { idempotencyKey: key, actorUserId: userId });
				expect(result.reused).toBe(false);
				expect(result.jobId).not.toBe(crashedJobId);
				const realJob = await jobQueue.get(result.jobId);
				expect(realJob?.status).toBe("pending");

				// The reconcile is a NO-OP: no consumption ever existed for the crashed jobId
				// (no negative debit recorded for it), and no active reservation remains for it.
				const crashedActiveReserved = usageLedger.listEvents().some((e) => (
					e.workspaceId === projectId && e.subjectId === crashedJobId && e.kind === "ai_credit_reserved"
				));
				expect(crashedActiveReserved).toBe(false);

				// Exactly ONE active reservation remains — the retry's — and the net credit
				// debit is exactly the retry job's size-flat credit price (creditUnits); the
				// THB usage reservation still equals reserveThb. The harmless reconcile neither
				// refunded nor leaked.
				const actualReserve = result.costEstimate?.reserveThb ?? 0;
				const retryCreditUnits = result.costEstimate?.creditUnits ?? 0;
				expect(actualReserve).toBeGreaterThan(0);
				expect(retryCreditUnits).toBeGreaterThan(0);
				const summary = usageLedger.summarize(projectId, projectId);
				expect(summary.monthly.aiActiveReservedThb).toBe(actualReserve);

				const after = getBalance("member", userId, projectId);
				const debited = Math.round((before.total - after.total) * 10_000) / 10_000;
				expect(debited).toBe(retryCreditUnits);
			});
		} finally {
			if (previousTimeout === undefined) delete process.env.AI_CLAIM_MATERIALIZE_TIMEOUT_MS;
			else process.env.AI_CLAIM_MATERIALIZE_TIMEOUT_MS = previousTimeout;
		}
	});

	test("crash-after-consume-before-reserve: claim flagged needs-reconcile, credits consumed, then crashed BEFORE the usage reservation — takeover releases the orphaned consumption, retry charges ONCE (money P1 #2)", async () => {
		const previousTimeout = process.env.AI_CLAIM_MATERIALIZE_TIMEOUT_MS;
		process.env.AI_CLAIM_MATERIALIZE_TIMEOUT_MS = "60";
		try {
			await withSubmissionFixture(async ({ projectId, imageId, submitAiJob, jobQueue }) => {
				const { grantCredits, getBalance, consume: consumeCredits } = await import("../services/credits.js");
				const { usageLedger } = await import("../services/usage-ledger.js");
				const userId = `user-${uuid()}`;
				await grantCredits({
					workspaceId: projectId,
					ownerScope: "workspace",
					ownerId: projectId,
					creditClass: "shareable",
					amount: 100_000,
					source: "goodwill",
				});
				const before = getBalance("member", userId, projectId);

				const input = {
					projectId,
					imageId,
					crop: { x: 0, y: 0, w: 32, h: 32 },
					lang: "en",
					tier: "sfx-pro" as const,
					quality: "low" as const,
				};
				const key = `crash-midcharge-${projectId}`;

				// Simulate the partial-charge crash window the fix targets: the owner FLAGGED
				// the claim needs-reconcile (BEFORE the first write), debited credits, then
				// CRASHED before reserveAiCredit. The persisted claim reads charged:true and a
				// real credit debit exists for the dead jobId, but there is NO usage reservation.
				const crashedJobId = uuid();
				const reserveThb = 36;
				await jobQueue.claimIdempotency([key], crashedJobId);
				await jobQueue.markIdempotencyClaimCharged([key], crashedJobId);
				await consumeCredits(projectId, userId, reserveThb, "ai_job_submitted", crashedJobId);

				// Sanity: the crashed owner's credit debit is live; no reservation exists yet.
				const midDebit = Math.round((before.total - getBalance("member", userId, projectId).total) * 10_000) / 10_000;
				expect(midDebit).toBe(reserveThb);
				const crashedReservedBefore = usageLedger.listEvents().some((e) => (
					e.workspaceId === projectId && e.subjectId === crashedJobId && e.kind === "ai_credit_reserved"
				));
				expect(crashedReservedBefore).toBe(false);

				// A fresh submit times out, TAKES OVER the stale charged claim, reconciles
				// (releases the orphaned consumption — the reservation release is a no-op since
				// none was written), and charges its own fresh job exactly once.
				const result = await submitAiJob(input, { idempotencyKey: key, actorUserId: userId });
				expect(result.reused).toBe(false);
				expect(result.jobId).not.toBe(crashedJobId);

				// The crashed jobId's consumption is REFUNDED (no leak): net credit debit
				// equals exactly the retry job's size-flat credit price (creditUnits), not two.
				const actualReserve = result.costEstimate?.reserveThb ?? 0;
				const retryCreditUnits = result.costEstimate?.creditUnits ?? 0;
				expect(actualReserve).toBeGreaterThan(0);
				expect(retryCreditUnits).toBeGreaterThan(0);
				const after = getBalance("member", userId, projectId);
				const debited = Math.round((before.total - after.total) * 10_000) / 10_000;
				expect(debited).toBe(retryCreditUnits);

				// Exactly ONE active reservation remains — the retry's.
				const summary = usageLedger.summarize(projectId, projectId);
				expect(summary.monthly.aiActiveReservedThb).toBe(actualReserve);
			});
		} finally {
			if (previousTimeout === undefined) delete process.env.AI_CLAIM_MATERIALIZE_TIMEOUT_MS;
			else process.env.AI_CLAIM_MATERIALIZE_TIMEOUT_MS = previousTimeout;
		}
	});

	test("a legitimate idempotent retry returns the same job charged ONCE", async () => {
		await withSubmissionFixture(async ({ projectId, imageId, submitAiJob, jobQueue }) => {
			const { grantCredits, getBalance } = await import("../services/credits.js");
			const { usageLedger } = await import("../services/usage-ledger.js");
			const userId = `user-${uuid()}`;
			await grantCredits({
				workspaceId: projectId,
				ownerScope: "workspace",
				ownerId: projectId,
				creditClass: "shareable",
				amount: 100_000,
				source: "goodwill",
			});
			const before = getBalance("member", userId, projectId);

			const input = {
				projectId,
				imageId,
				crop: { x: 0, y: 0, w: 32, h: 32 },
				lang: "en",
				tier: "sfx-pro" as const,
				quality: "low" as const,
			};
			const key = `retry-idem-${projectId}`;

			const first = await submitAiJob(input, { idempotencyKey: key, actorUserId: userId });
			const again = await submitAiJob(input, { idempotencyKey: key, actorUserId: userId });

			expect(first.reused).toBe(false);
			expect(again.reused).toBe(true);
			expect(again.jobId).toBe(first.jobId);

			// Credit bucket debited the size-flat per-op CREDIT price (creditUnits) exactly
			// once; the idempotent retry charges nothing more. The usage-ledger reservation
			// (asserted below) is the separate THB meter.
			const creditUnits = first.costEstimate?.creditUnits ?? 0;
			expect(creditUnits).toBeGreaterThan(0);
			const after = getBalance("member", userId, projectId);
			expect(Math.round((before.total - after.total) * 10_000) / 10_000).toBe(creditUnits);

			const reservations = usageLedger
				.listEvents()
				.filter((e) => e.workspaceId === projectId && e.kind === "ai_credit_reserved");
			expect(reservations).toHaveLength(1);
		});
	});

	test("marker rerun rolls back (cancels + refunds) the queued job when the marker state-write FAILS", async () => {
			await withSubmissionFixture(async ({ projectId, imageId, submitAiJob, jobQueue }) => {
				const { Hono } = await import("hono");
				const { project, setExportArtifactStateWriteFailureForTests } = await import("../routes/project.js");
				const { grantCredits } = await import("../services/credits.js");
				const { usageLedger } = await import("../services/usage-ledger.js");
				const { PROJECTS_DIR, serverConfig } = await import("../config.js");
				// The fixture project has no userId/workspaceId — exercise it through the
				// legacy anonymous prototype hatch so the rerun route's ownership check
				// passes and we reach the charge→write→rollback path under test.
				const prevAllowAnon = serverConfig.allowLegacyAnonymousProjects;
				Object.assign(serverConfig as unknown as Record<string, unknown>, { allowLegacyAnonymousProjects: true });

				await grantCredits({
					workspaceId: projectId,
					ownerScope: "workspace",
					ownerId: projectId,
					creditClass: "shareable",
					amount: 100_000,
					source: "goodwill",
				});

				// The source job the failed marker points at (charged + queued).
				const source = await submitAiJob({
					projectId,
					imageId,
					crop: { x: 0, y: 0, w: 32, h: 32 },
					lang: "en",
					tier: "sfx-pro",
					quality: "low",
				}, { idempotencyKey: `rollback-source-${projectId}` });

				// Seed a project state.json with a FAILED marker referencing that job so the
				// rerun endpoint is reachable (only failed/retry_requested markers can rerun).
				const now = new Date().toISOString();
				const markerId = `marker-${uuid()}`;
				const state: ProjectState = {
					projectId,
					userId: "",
					name: "Rollback",
					createdAt: now,
					currentPage: 0,
					targetLang: "en",
					targetLangs: ["en"],
					pages: [{ imageId, imageName: imageId, textLayers: [], imageLayers: [], pendingAiJobs: [], coverRect: null } as unknown as PageState],
					aiReviewMarkers: [{
						id: markerId,
						jobId: source.jobId,
						pageIndex: 0,
						imageId,
						region: { x: 0, y: 0, w: 32, h: 32 },
						status: "failed",
						tier: "sfx-pro",
						targetLang: "en",
						createdAt: now,
						updatedAt: now,
					}],
				} as unknown as ProjectState;
				const stateDir = join(PROJECTS_DIR, projectId);
				mkdirSync(stateDir, { recursive: true });
				writeFileSync(join(stateDir, "state.json"), JSON.stringify(state, null, 2));

				const app = new Hono();
				app.route("/api/project", project);

				// Force the marker-state write to FAIL right after submitAiJob charges+queues
				// the rerun job. The rollback must cancel that orphaned job (→ refund).
				setExportArtifactStateWriteFailureForTests(() => {
					throw new Error("simulated marker state-write failure");
				});
				let rerunRes: Response;
				try {
					rerunRes = await app.request(`/api/project/${projectId}/ai-markers/${markerId}/rerun`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ lang: "en" }),
					});
				} finally {
					setExportArtifactStateWriteFailureForTests(null);
					Object.assign(serverConfig as unknown as Record<string, unknown>, { allowLegacyAnonymousProjects: prevAllowAnon });
				}

				// The route surfaces the write failure (not a 2xx success).
				expect(rerunRes.status).toBeGreaterThanOrEqual(500);

				// The rerun's NEW job (deterministic idempotency key) was rolled back:
				// cancelled, with its credit reservation released (refunded) — no orphan
				// charged+queued job left invisible to the marker UI.
				const rerunKey = `ai-marker-rerun:${projectId}:${markerId}:${source.jobId}:en:${now}`;
				const rerunJob = await jobQueue.getByIdempotencyKey(rerunKey);
				expect(rerunJob).toBeTruthy();
				expect(rerunJob?.status).toBe("cancelled");
				expect(rerunJob?.creditReservation?.status === "released" || rerunJob?.creditReservation === undefined).toBe(true);

				// Net effect: only the SOURCE job's reservation remains active — the rerun's
				// was refunded — so the rollback prevented a double-charge with no marker.
				const activeReserved = usageLedger.summarize(projectId, projectId).monthly.aiActiveReservedThb;
				const sourceReserve = source.costEstimate?.reserveThb ?? 0;
				expect(Math.round(activeReserved * 10_000) / 10_000).toBe(Math.round(sourceReserve * 10_000) / 10_000);
			});
		});
});

describe("queue snapshot store persists target language across a reload", () => {
	// Proves the file/memory queue store (the active-job source of truth) round-trips
	// `AiJob.lang` — i.e. the per-language dimension is durable, not just in-memory.
	test("FileQueueSnapshotStore reload preserves AiJob.lang", async () => {
		const previousMode = process.env.AI_QUEUE_STORE;
		process.env.AI_QUEUE_STORE = "file";
		const dir = join(tmpdir(), `pl-ai-queue-${uuid()}`);
		mkdirSync(dir, { recursive: true });
		const persistPath = join(dir, "ai-jobs.json");
		try {
			const { JobQueue } = await import("../services/queue.js");
			const job: AiJob = {
				jobId: uuid(),
				projectId: uuid(),
				imageId: "page-0.png",
				crop: { x: 0, y: 0, w: 32, h: 32 },
				lang: "ja",
				prompt: "translate sfx",
				tier: "sfx-pro",
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			const writer = new JobQueue(2, persistPath);
			await writer.ready();
			await writer.add(job, { idempotencyKey: `reload-${job.jobId}` });

			// A fresh queue instance reading the same file recovers the job WITH its lang.
			const reader = new JobQueue(2, persistPath);
			await reader.ready();
			const reloaded = await reader.get(job.jobId);
			expect(reloaded?.lang).toBe("ja");
			expect(JSON.parse(readFileSync(persistPath, "utf-8")).jobs[0].lang).toBe("ja");
		} finally {
			if (previousMode === undefined) delete process.env.AI_QUEUE_STORE;
			else process.env.AI_QUEUE_STORE = previousMode;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
