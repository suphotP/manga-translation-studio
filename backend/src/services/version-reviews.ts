import { v4 as uuid } from "uuid";
import type { ProjectState, VersionReviewRequest, VersionReviewStatus } from "../types/index.js";
import { extractProjectCommentMentions } from "./comments.js";

export const MAX_VERSION_REVIEW_REQUESTS = 500;

/** Like {@link normalizeVersionReviewRequests} but returns TRUE iff it changed
 *  `state.versionReviewRequests` (small capped array compare — no whole-state hash). */
export function normalizeVersionReviewRequestsChanged(state: ProjectState): boolean {
	const prev = JSON.stringify(state.versionReviewRequests);
	const requests = Array.isArray(state.versionReviewRequests) ? state.versionReviewRequests : [];
	state.versionReviewRequests = requests
		.slice(0, MAX_VERSION_REVIEW_REQUESTS)
		.map((request) => ({
			...request,
			mentions: Array.isArray(request.mentions)
				? request.mentions
				: extractProjectCommentMentions(request.body ?? ""),
		}));
	return JSON.stringify(state.versionReviewRequests) !== prev;
}

export function normalizeVersionReviewRequests(state: ProjectState): VersionReviewRequest[] {
	normalizeVersionReviewRequestsChanged(state);
	return state.versionReviewRequests;
}

export function createVersionReviewRequest(input: {
	versionId: string;
	body?: string;
	requester?: string;
}): VersionReviewRequest {
	const now = new Date().toISOString();
	return {
		id: uuid(),
		versionId: input.versionId,
		status: "open",
		body: input.body,
		requester: input.requester ?? "local-user",
		mentions: extractProjectCommentMentions(input.body ?? ""),
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * A version-review request may only be DECIDED (approved / changes-requested) by
 * someone other than the original requester. Self-review is a security bypass:
 * the requester could rubber-stamp their own version. Reopening (status "open")
 * and an unattributed/local actor are allowed.
 */
export function isSelfReviewDecision(
	request: VersionReviewRequest,
	input: { status: VersionReviewStatus; reviewer?: string },
): boolean {
	if (input.status === "open") return false;
	const reviewer = input.reviewer?.trim();
	if (!reviewer || reviewer === "local-user") return false;
	return reviewer === request.requester;
}

export function updateVersionReviewRequest(
	request: VersionReviewRequest,
	input: {
		status: VersionReviewStatus;
		body?: string;
		reviewer?: string;
	},
): VersionReviewRequest {
	const now = new Date().toISOString();
	// Preserve the original request description on `body`. A reviewer's note is a
	// SEPARATE field (`decisionNote`) so applying a decision never destroys the
	// requester's original text/mentions (no decision data-loss).
	const decisionNote = input.status === "open"
		? undefined
		: input.body?.trim() || request.decisionNote;
	const requestBody = request.body;
	const mentionSource = `${requestBody ?? ""} ${decisionNote ?? ""}`;
	return {
		...request,
		status: input.status,
		body: requestBody,
		decisionNote,
		reviewer: input.reviewer ?? request.reviewer,
		mentions: extractProjectCommentMentions(mentionSource),
		updatedAt: now,
		decidedAt: input.status === "open" ? undefined : now,
	};
}

export function getLatestVersionReview(
	state: ProjectState,
	versionId: string,
): VersionReviewRequest | null {
	return normalizeVersionReviewRequests(state)
		.filter((request) => request.versionId === versionId)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

