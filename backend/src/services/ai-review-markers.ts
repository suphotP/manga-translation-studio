import { v4 as uuid } from "uuid";
import type { AiJobMarkerView,
	AiCostEstimate,
	AiJob,
	AiReviewMarker,
	AiReviewMarkerStatus,
	AiTier,
	CreditReservation,
	JobStatus,
	ProjectState,
} from "../types/index.js";
import { normalizeAssigneeHandle } from "./assignees.js";
import { sanitizeOptionalAiError } from "../utils/ai-error-sanitizer.js";

export const MAX_AI_REVIEW_MARKERS = 1000;

// AI job statuses that are still in-flight: a `processing` marker whose job is in
// one of these is NOT stale and must be left alone (the live poll loop / worker
// will still drive it). Any OTHER job status is terminal and lets us project a
// durable marker state without a live client poll.
const IN_FLIGHT_JOB_STATUSES = new Set<JobStatus>([
	"pending",
	"policy_checking",
	"waiting_credit",
	"processing",
	"retrying",
]);

// Fixed, leak-safe message stored on a marker when its job finished but produced
// no result image. Mirrors the FE `formatAiMissingResultFailure()` copy. It is
// not provider text, but it still flows through `updateAiReviewMarker`'s
// allowlist sanitizer; "missing result" is unrecognised there, so the stored
// value is the generic AI-error fallback (acceptable — the `failed` status is
// the load-bearing signal and no raw provider text can leak).
const MARKER_MISSING_RESULT_ERROR = "AI จบงานแล้วแต่ไม่มีรูปผลลัพธ์";

/** Like {@link normalizeAiReviewMarkers} but returns TRUE iff it changed `state.aiReviewMarkers`
 *  (the capped array + the per-marker in-place field normalization below), compared via a small
 *  pre-snapshot — no whole-state hash. */
export function normalizeAiReviewMarkersChanged(state: ProjectState): boolean {
	const prev = JSON.stringify(state.aiReviewMarkers);
	const markers = Array.isArray(state.aiReviewMarkers) ? state.aiReviewMarkers : [];
	state.aiReviewMarkers = markers.slice(0, MAX_AI_REVIEW_MARKERS);
	for (const marker of state.aiReviewMarkers) {
		marker.linkedCommentIds = Array.isArray(marker.linkedCommentIds)
			? marker.linkedCommentIds.filter((id): id is string => typeof id === "string").slice(0, 50)
			: [];
		marker.linkedTaskIds = Array.isArray(marker.linkedTaskIds)
			? marker.linkedTaskIds.filter((id): id is string => typeof id === "string").slice(0, 50)
			: [];
		if (typeof marker.assignee === "string") {
			marker.assignee = normalizeAssigneeHandle(marker.assignee);
		}
		if (typeof marker.sourceMarkerId === "string") {
			marker.sourceMarkerId = marker.sourceMarkerId.trim() || undefined;
		}
		if (typeof marker.rerunIdempotencyKey === "string") {
			marker.rerunIdempotencyKey = marker.rerunIdempotencyKey.trim() || undefined;
		}
		// Per-language bucket key (Stream C). Legacy markers without `targetLang`
		// stay undefined and map to the project default via the catalog accessor.
		if (typeof marker.targetLang === "string") {
			marker.targetLang = marker.targetLang.trim().toLowerCase() || undefined;
		}
		if (typeof marker.customPrompt === "string") {
			marker.customPrompt = marker.customPrompt.trim() || undefined;
		}
		// LEAK-SAFE (prompt class, sibling to #258/#278): the internal system/
		// template prompt (the ~900-char `buildPrompt` output) must NEVER live in
		// client-readable project state or be served over the markers API — it is
		// internal request detail, not something the user needs. The user's OWN
		// input is preserved separately as `customPrompt`. Scrub any `prompt` that a
		// legacy marker (or a client POST that slipped it past the schema) persisted,
		// so a normalize-on-read/write strips it even from already-stored state.
		if ("prompt" in (marker as Record<string, unknown>)) {
			delete (marker as Record<string, unknown>).prompt;
		}
		marker.textLayers = Array.isArray(marker.textLayers)
			? marker.textLayers.filter((text): text is string => typeof text === "string").map((text) => text.trim()).filter(Boolean).slice(0, 50)
			: undefined;
	}
	return JSON.stringify(state.aiReviewMarkers) !== prev;
}

export function normalizeAiReviewMarkers(state: ProjectState): AiReviewMarker[] {
	normalizeAiReviewMarkersChanged(state);
	return state.aiReviewMarkers;
}

export function createAiReviewMarker(input: {
	jobId: string;
	pageIndex: number;
	imageId: string;
	region: { x: number; y: number; w: number; h: number };
	status?: AiReviewMarkerStatus;
	tier: AiTier;
	providerHint?: string;
	/**
	 * Accepted (and tolerated for back-compat with existing callers/clients that
	 * still pass it) but DELIBERATELY NOT persisted on the marker — see the
	 * leak-safe note below. The internal system/template prompt is never stored or
	 * served. Use `customPrompt` for the user's own instruction.
	 */
	prompt?: string;
	customPrompt?: string;
	textLayers?: string[];
	translateSfx?: boolean;
	costEstimate?: AiCostEstimate;
	creditReservation?: CreditReservation;
	resultImageId?: string;
	error?: string;
	assignee?: string;
	linkedCommentIds?: string[];
	linkedTaskIds?: string[];
	sourceMarkerId?: string;
	rerunIdempotencyKey?: string;
	targetLang?: string;
}): AiReviewMarker {
	const now = new Date().toISOString();
	const targetLang = typeof input.targetLang === "string"
		? input.targetLang.trim().toLowerCase() || undefined
		: undefined;
	return {
		id: uuid(),
		jobId: input.jobId,
		pageIndex: input.pageIndex,
		imageId: input.imageId,
		region: input.region,
		status: input.status ?? "processing",
		tier: input.tier,
		providerHint: input.providerHint,
		// LEAK-SAFE: the internal system/template `prompt` is intentionally NOT
		// stored on the marker (it would otherwise be served over GET /ai-markers
		// and persisted in client-readable project state). Only the user's own
		// `customPrompt` is kept. `input.prompt` is accepted for back-compat but
		// dropped here.
		customPrompt: input.customPrompt?.trim() || undefined,
		textLayers: Array.isArray(input.textLayers) ? input.textLayers.map((text) => text.trim()).filter(Boolean).slice(0, 50) : undefined,
		translateSfx: input.translateSfx,
		costEstimate: input.costEstimate,
		creditReservation: input.creditReservation,
		resultImageId: input.resultImageId,
		// Defense-at-write: a failed AI job's `error` reaches here from the client
		// (the FE polling loop posts the provider failure text) and is served over
		// the markers API + persisted in project state. Funnel it through the
		// allowlist sanitizer so a raw provider error (OpenAI 401 key fragment, a
		// leaked system/user prompt, a role-dump, …) is NEVER stored — only a
		// fixed friendly/generic message.
		error: sanitizeOptionalAiError(input.error),
		assignee: normalizeAssigneeHandle(input.assignee),
		linkedCommentIds: Array.isArray(input.linkedCommentIds) ? input.linkedCommentIds.slice(0, 50) : [],
		linkedTaskIds: Array.isArray(input.linkedTaskIds) ? input.linkedTaskIds.slice(0, 50) : [],
		sourceMarkerId: input.sourceMarkerId?.trim() || undefined,
		rerunIdempotencyKey: input.rerunIdempotencyKey?.trim() || undefined,
		targetLang,
		createdAt: now,
		updatedAt: now,
	};
}

export interface ReconcileMarkerResult {
	/** Whether any marker was transitioned to a terminal state by this pass. */
	changed: boolean;
	/** Ids of the markers that self-healed out of a stale `processing` state. */
	reconciledMarkerIds: string[];
}

/**
 * Self-heal AI review markers stuck in `processing` against the DURABLE AI job
 * result — independently of any live client poll loop.
 *
 * The marker→result linkage (resultImageId + terminal status) was previously set
 * ONLY client-side in the poll loop (`ai-jobs.svelte.ts`). When a user navigates
 * away mid-generation (real gens take minutes), the backend job still completes
 * and durably persists `job.resultImageId`/`job.status`, but the marker is left
 * `processing` forever and the finished result is orphaned. This reconciler reads
 * each stale marker's job by its `jobId` (the marker already carries it) and
 * projects the job's terminal state onto the marker:
 *
 *   - job `done` + resultImageId  → marker `needs_review` + resultImageId (ready)
 *   - job `done`, no resultImageId → marker `failed` (missing result)
 *   - job `needs_review`           → marker `needs_review` (moderation review)
 *   - job `error`/`blocked`/`cancelled` → marker `failed` (sanitized job.error)
 *   - job still in-flight / not found   → marker left untouched
 *
 * Idempotent: a marker already in a terminal state (or whose job is still
 * running) is skipped, so it is safe to run on every markers read AND to race
 * harmlessly with a live poll loop (whichever lands first wins; the other
 * no-ops). Mutates markers in place and returns what changed. `resolveJob`
 * looks up an `AiJob` by id (e.g. `jobQueue.get`); a thrown/undefined lookup
 * leaves that marker untouched.
 *
 * #278 (server-side error sanitization) is preserved: marker errors here are
 * taken from `job.error`, which is already allowlist-sanitized at the queue
 * layer, and `updateAiReviewMarker` re-sanitizes on write — no key/prompt leaks.
 */
export async function reconcileProcessingAiReviewMarkers(
	state: ProjectState,
	// Accepts the marker VIEW (a full AiJob satisfies it structurally) so the
	// queue can serve a compact terminal projection for jobs whose full row was
	// already evicted by retention — see JobQueue.getMarkerReconcileView.
	resolveJob: (jobId: string) => Promise<AiJobMarkerView | undefined>,
): Promise<ReconcileMarkerResult> {
	const markers = normalizeAiReviewMarkers(state);
	const reconciledMarkerIds: string[] = [];

	for (const marker of markers) {
		// `processing` markers reconcile normally. ALSO repair a `needs_review`
		// marker that has NO resultImageId yet: the client PATCH sets the status
		// the moment its poll sees `done`, but the update schema strips
		// `resultImageId` (server-side-only by design) — without this branch the
		// marker is stuck showing "รอผล" forever because reconcile skipped
		// anything not `processing` (real-user bug, confirmed by live audit).
		const missingResult = marker.status === "needs_review" && !marker.resultImageId;
		if (marker.status !== "processing" && !missingResult) continue;
		if (!marker.jobId || typeof marker.jobId !== "string") continue;

		let job: AiJobMarkerView | undefined;
		try {
			job = await resolveJob(marker.jobId);
		} catch {
			// A transient lookup failure must not clobber the marker — leave it
			// `processing` so a later read/poll can still reconcile it.
			continue;
		}
		if (!job) continue;
		if (IN_FLIGHT_JOB_STATUSES.has(job.status)) continue;
		// The missing-result repair applies ONLY to a job that actually finished
		// WITH a result (the stripped-PATCH case). A job parked in needs_review
		// by prompt moderation legitimately has no resultImageId — re-selecting
		// it would rewrite the same update forever (changed:true churn, codex P2).
		if (missingResult && !(job.status === "done" && job.resultImageId)) continue;

		const update = resolveMarkerUpdateFromJob(job);
		if (!update) continue;

		updateAiReviewMarker(marker, update);
		reconciledMarkerIds.push(marker.id);
	}

	return { changed: reconciledMarkerIds.length > 0, reconciledMarkerIds };
}

function resolveMarkerUpdateFromJob(job: AiJobMarkerView): Parameters<typeof updateAiReviewMarker>[1] | null {
	switch (job.status) {
		case "done":
			return job.resultImageId
				? {
					status: "needs_review",
					resultImageId: job.resultImageId,
					costEstimate: job.costEstimate,
					creditReservation: job.creditReservation,
					// Clear any stale error so a recovered ready result is not shown as failed.
					error: "",
				}
				: {
					status: "failed",
					error: MARKER_MISSING_RESULT_ERROR,
					costEstimate: job.costEstimate,
					creditReservation: job.creditReservation,
				};
		case "needs_review":
			// Soft moderation/review hold — surface for human review, not a hard fail.
			return {
				status: "needs_review",
				error: job.error,
				costEstimate: job.costEstimate,
				creditReservation: job.creditReservation,
			};
		case "error":
		case "blocked":
		case "cancelled":
			return {
				status: "failed",
				// job.error is already #278-sanitized at the queue layer; the marker
				// service re-sanitizes on write. Empty falls back to the generic message.
				error: job.error,
				costEstimate: job.costEstimate,
				creditReservation: job.creditReservation,
			};
		default:
			return null;
	}
}

export function updateAiReviewMarker(
	marker: AiReviewMarker,
	update: Partial<Pick<
		AiReviewMarker,
		| "status"
		| "providerHint"
		| "customPrompt"
		| "textLayers"
		| "translateSfx"
		| "costEstimate"
		| "creditReservation"
		| "resultImageId"
		| "error"
		| "linkedCommentIds"
		| "linkedTaskIds"
		| "sourceMarkerId"
		| "rerunIdempotencyKey"
	>> & { assignee?: string | null }
): AiReviewMarker {
	for (const [key, value] of Object.entries(update)) {
		if (value === undefined) continue;
		// LEAK-SAFE: never write the internal system/template prompt onto a marker.
		// `prompt` is dropped from the allowlist type above, but guard at runtime
		// too so a legacy/`as any` caller can't smuggle it back into stored state.
		if (key === "prompt") {
			delete (marker as Record<string, unknown>).prompt;
			continue;
		}
		if (key === "assignee") {
			const assignee = typeof value === "string" ? normalizeAssigneeHandle(value) : undefined;
			if (assignee) {
				marker.assignee = assignee;
			} else {
				delete marker.assignee;
			}
		} else if (key === "linkedCommentIds" || key === "linkedTaskIds") {
			(marker as unknown as Record<string, unknown>)[key] = Array.isArray(value)
				? value.filter((id): id is string => typeof id === "string").slice(0, 50)
				: [];
		} else if (key === "textLayers") {
			(marker as unknown as Record<string, unknown>)[key] = Array.isArray(value)
				? value.filter((text): text is string => typeof text === "string").map((text) => text.trim()).filter(Boolean).slice(0, 50)
				: undefined;
		} else if (key === "customPrompt") {
			const customPrompt = typeof value === "string" ? value.trim() : "";
			if (customPrompt) {
				marker.customPrompt = customPrompt;
			} else {
				delete marker.customPrompt;
			}
		} else if (key === "error") {
			// Defense-at-write: a marker status update (the FE posts the failed
			// job's provider error onto the marker) must never persist raw
			// provider text. Allowlist-sanitize before storing; an empty/cleared
			// value drops the field rather than fabricating a message.
			const sanitized = typeof value === "string" ? sanitizeOptionalAiError(value) : undefined;
			if (sanitized) {
				marker.error = sanitized;
			} else {
				delete marker.error;
			}
		} else {
			(marker as unknown as Record<string, unknown>)[key] = value;
		}
	}
	marker.updatedAt = new Date().toISOString();
	return marker;
}

export function linkAiReviewMarkerComment(marker: AiReviewMarker, commentId: string): AiReviewMarker {
	const existing = Array.isArray(marker.linkedCommentIds) ? marker.linkedCommentIds : [];
	marker.linkedCommentIds = [commentId, ...existing.filter((id) => id !== commentId)].slice(0, 50);
	marker.updatedAt = new Date().toISOString();
	return marker;
}

export function linkAiReviewMarkerTask(marker: AiReviewMarker, taskId: string): AiReviewMarker {
	const existing = Array.isArray(marker.linkedTaskIds) ? marker.linkedTaskIds : [];
	marker.linkedTaskIds = [taskId, ...existing.filter((id) => id !== taskId)].slice(0, 50);
	marker.updatedAt = new Date().toISOString();
	return marker;
}
