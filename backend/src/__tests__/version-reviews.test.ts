import { describe, expect, test } from "bun:test";
import { createVersionReviewRequest, isSelfReviewDecision, normalizeVersionReviewRequests, updateVersionReviewRequest } from "../services/version-reviews.js";
import type { ProjectState } from "../types/index.js";

function projectState(): ProjectState {
	return {
		projectId: "proj-1",
		userId: "",
		name: "Version review test",
		createdAt: "",
		pages: [],
		currentPage: 0,
		targetLang: "th",
		versionReviewRequests: [],
	};
}

describe("version reviews", () => {
	test("creates version review requests with mentions", () => {
		const review = createVersionReviewRequest({
			versionId: "version-1",
			body: "Please review this snapshot @lead",
			requester: "typesetter",
		});

		expect(review.status).toBe("open");
		expect(review.requester).toBe("typesetter");
		expect(review.mentions).toEqual(["lead"]);
	});

	test("updates version review decisions and keeps mention metadata normalized", () => {
		const state = projectState();
		const review = createVersionReviewRequest({
			versionId: "version-1",
			body: "Needs check @lead",
		});
		state.versionReviewRequests = [{ ...review, mentions: undefined }];

		const normalized = normalizeVersionReviewRequests(state);
		const updated = updateVersionReviewRequest(normalized[0], {
			status: "changes_requested",
			body: "Fix layer drift @typesetter",
			reviewer: "lead",
		});

		expect(normalized[0].mentions).toEqual(["lead"]);
		expect(updated.status).toBe("changes_requested");
		expect(updated.reviewer).toBe("lead");
		// The decision preserves the original request body (and its @lead mention)
		// and records the reviewer note + its @typesetter mention SEPARATELY — the
		// original request data is never destroyed by a decision.
		expect(updated.body).toBe("Needs check @lead");
		expect(updated.decisionNote).toBe("Fix layer drift @typesetter");
		expect(updated.mentions).toEqual(["lead", "typesetter"]);
		expect(updated.decidedAt).toBeDefined();
	});

	test("preserves the original request body when a decision adds a note (no data-loss)", () => {
		const request = createVersionReviewRequest({
			versionId: "version-9",
			body: "Original request description @lead",
			requester: "typesetter",
		});

		const decided = updateVersionReviewRequest(request, {
			status: "approved",
			body: "Looks good, shipping it",
			reviewer: "lead",
		});

		expect(decided.body).toBe("Original request description @lead");
		expect(decided.decisionNote).toBe("Looks good, shipping it");
		expect(decided.requester).toBe("typesetter");
		expect(decided.reviewer).toBe("lead");
		expect(decided.createdAt).toBe(request.createdAt);
		expect(decided.id).toBe(request.id);
	});

	test("flags a self-review decision (requester === reviewer) but allows reopen", () => {
		const request = createVersionReviewRequest({
			versionId: "version-5",
			body: "Please review @lead",
			requester: "lead@example.com",
		});

		expect(isSelfReviewDecision(request, { status: "approved", reviewer: "lead@example.com" })).toBe(true);
		expect(isSelfReviewDecision(request, { status: "changes_requested", reviewer: "lead@example.com" })).toBe(true);
		// A different reviewer may decide.
		expect(isSelfReviewDecision(request, { status: "approved", reviewer: "qc@example.com" })).toBe(false);
		// Reopening your own request is allowed.
		expect(isSelfReviewDecision(request, { status: "open", reviewer: "lead@example.com" })).toBe(false);
		// File-mode single-user "local-user" is exempt (unauthenticated dev).
		const localReq = createVersionReviewRequest({ versionId: "version-6", requester: "local-user" });
		expect(isSelfReviewDecision(localReq, { status: "approved", reviewer: "local-user" })).toBe(false);
	});
});

