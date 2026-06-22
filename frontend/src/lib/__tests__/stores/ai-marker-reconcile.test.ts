// Reopen-time reconciliation (FE): when a project is reopened (or the AI panel
// mounts) after a gen finished while the tab/poll-loop was closed, the store asks
// the backend to durably reconcile stale `processing` markers against their jobs'
// terminal result, so the finished result surfaces as ready instead of a stuck
// spinner. Proves the store calls the reconcile endpoint only when something is
// actually processing, adopts the healed markers, and is a no-op otherwise.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { AiReviewMarker, ProjectState } from "$lib/types.js";

vi.mock("$lib/api/client.ts", () => ({
	getAiReviewMarkers: vi.fn(),
	reconcileAiReviewMarkers: vi.fn(),
}));

const BACKEND_PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function marker(overrides: Partial<AiReviewMarker> = {}): AiReviewMarker {
	const now = new Date().toISOString();
	return {
		id: `marker-${Math.random().toString(36).slice(2)}`,
		jobId: `job-${Math.random().toString(36).slice(2)}`,
		pageIndex: 0,
		imageId: "page-0.png",
		region: { x: 0, y: 0, w: 32, h: 32 },
		status: "processing",
		tier: "sfx-pro",
		linkedCommentIds: [],
		linkedTaskIds: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function project(markers: AiReviewMarker[]): ProjectState {
	return {
		projectId: BACKEND_PROJECT_ID,
		name: "reconcile fixture",
		createdAt: new Date().toISOString(),
		pages: [{ imageId: "page-0.png", imageName: "page-0.png", textLayers: [], pendingAiJobs: [], coverRect: null } as any],
		currentPage: 0,
		targetLang: "th",
		aiReviewMarkers: markers,
	} as ProjectState;
}

describe("projectStore.reconcileAiReviewMarkers (reopen-time orphaned-result recovery)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		projectStore.__setProjectForTesting(null);
	});

	it("recovers a stale processing marker: calls the endpoint and adopts the healed ready marker", async () => {
		const stale = marker({ id: "m1", status: "processing" });
		projectStore.__setProjectForTesting(project([stale]));

		const healed = marker({ id: "m1", status: "needs_review", resultImageId: "ai-result.png" });
		vi.mocked(api.reconcileAiReviewMarkers).mockResolvedValue({
			markers: [healed],
			reconciled: ["m1"],
			changed: true,
		});

		await projectStore.reconcileAiReviewMarkers();

		expect(api.reconcileAiReviewMarkers).toHaveBeenCalledWith(BACKEND_PROJECT_ID);
		expect(projectStore.aiReviewMarkers).toHaveLength(1);
		expect(projectStore.aiReviewMarkers[0].status).toBe("needs_review");
		expect(projectStore.aiReviewMarkers[0].resultImageId).toBe("ai-result.png");
	});

	it("does NOT hit the endpoint when no marker is processing (no needless round-trip)", async () => {
		projectStore.__setProjectForTesting(project([marker({ status: "accepted", resultImageId: "x.png" })]));

		await projectStore.reconcileAiReviewMarkers();

		expect(api.reconcileAiReviewMarkers).not.toHaveBeenCalled();
	});

	it("is a no-op with no project", async () => {
		projectStore.__setProjectForTesting(null);
		await projectStore.reconcileAiReviewMarkers();
		expect(api.reconcileAiReviewMarkers).not.toHaveBeenCalled();
	});

	it("does not call the backend for a local (non-backend) project id", async () => {
		const local = project([marker({ status: "processing" })]);
		(local as any).projectId = "flow208-project";
		projectStore.__setProjectForTesting(local);

		await projectStore.reconcileAiReviewMarkers();

		expect(api.reconcileAiReviewMarkers).not.toHaveBeenCalled();
	});

	it("swallows a reconcile error without throwing or clobbering markers", async () => {
		const stale = marker({ id: "m1", status: "processing" });
		projectStore.__setProjectForTesting(project([stale]));
		vi.mocked(api.reconcileAiReviewMarkers).mockRejectedValue(new Error("network down"));

		await expect(projectStore.reconcileAiReviewMarkers()).resolves.toBeUndefined();
		// The stale marker is left intact (still recoverable on a later attempt).
		expect(projectStore.aiReviewMarkers[0].status).toBe("processing");
	});
});
