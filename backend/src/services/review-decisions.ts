import { v4 as uuid } from "uuid";
import type { PageReviewDecision, ProjectState } from "../types/index.js";

export const MAX_PAGE_REVIEW_DECISIONS = 300;

/** Like {@link normalizeProjectReviewDecisions} but returns TRUE iff it changed
 *  `state.reviewDecisions` (small capped array compare — no whole-state hash). */
export function normalizeProjectReviewDecisionsChanged(state: ProjectState): boolean {
	const prev = JSON.stringify(state.reviewDecisions);
	const decisions = Array.isArray(state.reviewDecisions) ? state.reviewDecisions : [];
	state.reviewDecisions = decisions.slice(0, MAX_PAGE_REVIEW_DECISIONS);
	return JSON.stringify(state.reviewDecisions) !== prev;
}

export function normalizeProjectReviewDecisions(state: ProjectState): PageReviewDecision[] {
	normalizeProjectReviewDecisionsChanged(state);
	return state.reviewDecisions;
}

export function createPageReviewDecision(input: {
	pageIndex: number;
	status: PageReviewDecision["status"];
	body?: string;
	actor?: string;
}): PageReviewDecision {
	const now = new Date().toISOString();
	return {
		id: uuid(),
		pageIndex: input.pageIndex,
		status: input.status,
		body: input.body?.trim() || undefined,
		actor: input.actor ?? "local-user",
		createdAt: now,
		updatedAt: now,
	};
}
