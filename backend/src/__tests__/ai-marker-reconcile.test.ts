// Orphaned-AI-result reconciliation (P2): when an AI image job COMPLETES on the
// backend but the client poll loop closed before it finished (real gens take
// minutes), the marker→result linkage was previously set ONLY client-side, so the
// marker stayed `processing` FOREVER and the finished result was orphaned.
//
// `reconcileProcessingAiReviewMarkers` makes that linkage DURABLE and server-side:
// it projects each stale `processing` marker's job terminal result onto the marker
// with NO live client involved. These tests prove the marker reaches a terminal
// ready/failed state from the job alone, that it is idempotent / poll-safe, and
// that #278 server-side error sanitization is preserved on the failure path.

import { describe, test, expect } from "bun:test";
import { v4 as uuid } from "uuid";
import type { AiJob, AiReviewMarker, JobStatus, ProjectState } from "../types/index.js";
import {
	createAiReviewMarker,
	reconcileProcessingAiReviewMarkers,
} from "../services/ai-review-markers.js";
import { AI_PROVIDER_GENERIC_ERROR } from "../utils/ai-error-sanitizer.js";

function makeMarker(overrides: Partial<Parameters<typeof createAiReviewMarker>[0]> = {}): AiReviewMarker {
	return createAiReviewMarker({
		jobId: uuid(),
		pageIndex: 0,
		imageId: "page-0.png",
		region: { x: 0, y: 0, w: 32, h: 32 },
		tier: "sfx-pro",
		status: "processing",
		...overrides,
	});
}

function makeJob(jobId: string, status: JobStatus, overrides: Partial<AiJob> = {}): AiJob {
	return {
		jobId,
		projectId: uuid(),
		imageId: "page-0.png",
		crop: { x: 0, y: 0, w: 32, h: 32 },
		lang: "th",
		prompt: "translate",
		tier: "sfx-pro",
		status,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeState(markers: AiReviewMarker[]): ProjectState {
	return {
		projectId: uuid(),
		userId: "tester",
		name: "reconcile fixture",
		createdAt: new Date().toISOString(),
		pages: [],
		currentPage: 0,
		targetLang: "th",
		aiReviewMarkers: markers,
	};
}

// A resolver backed by a fixed map — stands in for `jobQueue.get`, but with NO
// client poll loop anywhere in sight: the whole point is the marker heals from
// the durable job record alone.
function resolverFor(jobs: Record<string, AiJob>) {
	return async (jobId: string) => jobs[jobId];
}

describe("reconcileProcessingAiReviewMarkers — durable marker→result linkage", () => {
	test("a job that COMPLETED while the client was away heals the marker to ready (needs_review + resultImageId)", async () => {
		const marker = makeMarker();
		const state = makeState([marker]);
		const job = makeJob(marker.jobId, "done", {
			resultImageId: "ai-result-123.png",
			costEstimate: { estimatedThb: 1, reserveThb: 1, currency: "THB", pricingVersion: "v1", quality: "low" } as any,
		});

		const result = await reconcileProcessingAiReviewMarkers(state, resolverFor({ [marker.jobId]: job }));

		expect(result.changed).toBe(true);
		expect(result.reconciledMarkerIds).toEqual([marker.id]);
		expect(state.aiReviewMarkers![0].status).toBe("needs_review");
		expect(state.aiReviewMarkers![0].resultImageId).toBe("ai-result-123.png");
		// No stuck error left behind on a recovered ready result.
		expect(state.aiReviewMarkers![0].error).toBeUndefined();
		expect(state.aiReviewMarkers![0].costEstimate).toBeDefined();
	});

	test("a needs_review marker MISSING resultImageId is repaired from the done job (client PATCH strips the id)", async () => {
		// Real-user bug (live audit): the client poll PATCHes status →
		// needs_review the moment it sees done, but the update schema strips
		// resultImageId (server-side-only). Reconcile previously skipped
		// non-processing markers, leaving the card stuck on "รอผล" forever.
		const marker = makeMarker();
		marker.status = "needs_review";
		marker.resultImageId = undefined;
		const state = makeState([marker]);
		const job = makeJob(marker.jobId, "done", { resultImageId: "ai-result-late.png" });

		const result = await reconcileProcessingAiReviewMarkers(state, resolverFor({ [marker.jobId]: job }));

		expect(result.changed).toBe(true);
		expect(state.aiReviewMarkers![0].status).toBe("needs_review");
		expect(state.aiReviewMarkers![0].resultImageId).toBe("ai-result-late.png");
	});

	test("a parked needs_review marker (moderation hold, job has no result) is NOT churned", async () => {
		const marker = makeMarker();
		marker.status = "needs_review";
		marker.resultImageId = undefined;
		const state = makeState([marker]);
		const job = makeJob(marker.jobId, "needs_review", {});

		const result = await reconcileProcessingAiReviewMarkers(state, resolverFor({ [marker.jobId]: job }));

		expect(result.changed).toBe(false);
	});

	test("a needs_review marker that ALREADY has its result is left untouched", async () => {
		const marker = makeMarker();
		marker.status = "needs_review";
		marker.resultImageId = "ai-result-existing.png";
		const state = makeState([marker]);
		const job = makeJob(marker.jobId, "done", { resultImageId: "ai-result-other.png" });

		const result = await reconcileProcessingAiReviewMarkers(state, resolverFor({ [marker.jobId]: job }));

		expect(result.changed).toBe(false);
		expect(state.aiReviewMarkers![0].resultImageId).toBe("ai-result-existing.png");
	});

	test("a job done with NO result image heals the marker to failed (no orphaned spinner)", async () => {
		const marker = makeMarker();
		const state = makeState([marker]);
		const job = makeJob(marker.jobId, "done"); // resultImageId undefined

		const result = await reconcileProcessingAiReviewMarkers(state, resolverFor({ [marker.jobId]: job }));

		expect(result.changed).toBe(true);
		expect(state.aiReviewMarkers![0].status).toBe("failed");
		expect(state.aiReviewMarkers![0].resultImageId).toBeUndefined();
	});

	test("a failed job heals the marker to failed and #278-sanitizes a leaky job error", async () => {
		const marker = makeMarker();
		const state = makeState([marker]);
		// A raw provider failure that echoes an API key — must NEVER be stored verbatim.
		const job = makeJob(marker.jobId, "error", {
			error: "401 Incorrect API key provided: sk-proj-LEAKEDKEY1234567890",
		});

		const result = await reconcileProcessingAiReviewMarkers(state, resolverFor({ [marker.jobId]: job }));

		expect(result.changed).toBe(true);
		expect(state.aiReviewMarkers![0].status).toBe("failed");
		const stored = state.aiReviewMarkers![0].error ?? "";
		expect(stored).not.toContain("sk-proj");
		expect(stored).not.toContain("LEAKEDKEY");
		// Maps to the fixed friendly auth/key category — a leak-safe allowlisted string.
		expect(stored.length).toBeGreaterThan(0);
	});

	test("a blocked job with no error text heals to failed without fabricating an error message", async () => {
		const marker = makeMarker();
		const state = makeState([marker]);
		const job = makeJob(marker.jobId, "blocked");

		await reconcileProcessingAiReviewMarkers(state, resolverFor({ [marker.jobId]: job }));

		// `failed` is the load-bearing signal; we don't invent error text the job
		// never had (the FE renders a friendly fallback for an empty marker error).
		expect(state.aiReviewMarkers![0].status).toBe("failed");
		expect(state.aiReviewMarkers![0].error).toBeUndefined();
	});

	test("a failed job whose error is unrecognised stores the generic (leak-safe) message, never raw text", async () => {
		const marker = makeMarker();
		const state = makeState([marker]);
		const job = makeJob(marker.jobId, "error", { error: "some totally novel leak shape blah blah" });

		await reconcileProcessingAiReviewMarkers(state, resolverFor({ [marker.jobId]: job }));

		expect(state.aiReviewMarkers![0].status).toBe("failed");
		expect(state.aiReviewMarkers![0].error).toBe(AI_PROVIDER_GENERIC_ERROR);
	});

	test("a job still in-flight leaves the marker processing (no premature heal)", async () => {
		const inFlightStatuses: JobStatus[] = ["pending", "policy_checking", "waiting_credit", "processing", "retrying"];
		for (const status of inFlightStatuses) {
			const marker = makeMarker();
			const state = makeState([marker]);
			const job = makeJob(marker.jobId, status);
			const result = await reconcileProcessingAiReviewMarkers(state, resolverFor({ [marker.jobId]: job }));
			expect(result.changed).toBe(false);
			expect(state.aiReviewMarkers![0].status).toBe("processing");
		}
	});

	test("a missing/unknown job leaves the marker untouched (cannot determine state)", async () => {
		const marker = makeMarker();
		const state = makeState([marker]);
		const result = await reconcileProcessingAiReviewMarkers(state, resolverFor({}));
		expect(result.changed).toBe(false);
		expect(state.aiReviewMarkers![0].status).toBe("processing");
	});

	test("a transient resolver failure does not clobber the marker", async () => {
		const marker = makeMarker();
		const state = makeState([marker]);
		const result = await reconcileProcessingAiReviewMarkers(state, async () => {
			throw new Error("redis unavailable");
		});
		expect(result.changed).toBe(false);
		expect(state.aiReviewMarkers![0].status).toBe("processing");
	});

	test("idempotent + poll-safe: only `processing` markers are touched; already-terminal markers are skipped", async () => {
		// Mirrors a live poll loop having ALREADY landed needs_review: a subsequent
		// reconcile must NOT re-apply / double-process it.
		const alreadyReady = makeMarker({ status: "needs_review", resultImageId: "already.png" });
		const accepted = makeMarker({ status: "accepted", resultImageId: "kept.png" });
		const stale = makeMarker(); // processing
		const state = makeState([alreadyReady, accepted, stale]);
		const jobs = {
			[alreadyReady.jobId]: makeJob(alreadyReady.jobId, "done", { resultImageId: "different.png" }),
			[accepted.jobId]: makeJob(accepted.jobId, "done", { resultImageId: "different2.png" }),
			[stale.jobId]: makeJob(stale.jobId, "done", { resultImageId: "fresh.png" }),
		};

		const result = await reconcileProcessingAiReviewMarkers(state, resolverFor(jobs));

		expect(result.reconciledMarkerIds).toEqual([stale.id]);
		// The already-terminal markers are left exactly as they were (no overwrite).
		expect(state.aiReviewMarkers!.find((m) => m.id === alreadyReady.id)?.resultImageId).toBe("already.png");
		expect(state.aiReviewMarkers!.find((m) => m.id === accepted.id)?.resultImageId).toBe("kept.png");
		// The genuinely stale marker self-heals to its job's durable result.
		const healed = state.aiReviewMarkers!.find((m) => m.id === stale.id);
		expect(healed?.status).toBe("needs_review");
		expect(healed?.resultImageId).toBe("fresh.png");
	});

	test("running twice is a no-op the second time (terminal state is stable)", async () => {
		const marker = makeMarker();
		const state = makeState([marker]);
		const job = makeJob(marker.jobId, "done", { resultImageId: "r.png" });
		const resolve = resolverFor({ [marker.jobId]: job });

		const first = await reconcileProcessingAiReviewMarkers(state, resolve);
		const second = await reconcileProcessingAiReviewMarkers(state, resolve);

		expect(first.changed).toBe(true);
		expect(second.changed).toBe(false);
		expect(state.aiReviewMarkers![0].status).toBe("needs_review");
	});
});
