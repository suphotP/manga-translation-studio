import { describe, expect, it } from "vitest";
import {
	buildAiRegionHistories,
	findAiRegionHistoryForMarker,
	findAiRegionVersion,
} from "$lib/project/ai-review-region-history.js";
import type { AiReviewMarker } from "$lib/types.js";

function marker(overrides: Partial<AiReviewMarker> & Pick<AiReviewMarker, "id">): AiReviewMarker {
	return {
		jobId: `job-${overrides.id}`,
		pageIndex: 0,
		imageId: "img-1",
		region: { x: 100, y: 100, w: 200, h: 200 },
		status: "needs_review",
		tier: "sfx-pro",
		createdAt: "2026-06-01T00:00:00.000Z",
		updatedAt: "2026-06-01T00:00:00.000Z",
		...overrides,
	};
}

describe("AI region history", () => {
	it("groups a rerun lineage into one ordered history (oldest → newest)", () => {
		const v1 = marker({ id: "v1", createdAt: "2026-06-01T00:00:00.000Z", status: "accepted" });
		const v2 = marker({ id: "v2", sourceMarkerId: "v1", createdAt: "2026-06-01T00:05:00.000Z" });
		const v3 = marker({ id: "v3", sourceMarkerId: "v2", createdAt: "2026-06-01T00:10:00.000Z" });
		const histories = buildAiRegionHistories([v3, v1, v2]);
		expect(histories).toHaveLength(1);
		expect(histories[0].versions.map((entry) => entry.marker.id)).toEqual(["v1", "v2", "v3"]);
		expect(histories[0].versions.map((entry) => entry.version)).toEqual([1, 2, 3]);
		expect(histories[0].lineageId).toBe("v1");
	});

	it("orders versions by createdAt even when updatedAt disagrees (shared key with the overlay)", () => {
		// The canvas overlay's recency tiebreak and this version order MUST use the
		// SAME key (createdAt || updatedAt). A later updatedAt (e.g. an edit/accept on
		// the older generation) must NOT reorder the version lineage, or "‹ รุ่นก่อน"
		// would step to the wrong generation.
		const v1 = marker({ id: "v1", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T09:00:00.000Z" });
		const v2 = marker({ id: "v2", sourceMarkerId: "v1", createdAt: "2026-06-01T00:05:00.000Z", updatedAt: "2026-06-01T00:06:00.000Z" });
		const histories = buildAiRegionHistories([v2, v1]);
		expect(histories[0].versions.map((entry) => entry.marker.id)).toEqual(["v1", "v2"]);
	});

	it("keeps separate regions in separate histories", () => {
		const a = marker({ id: "a", region: { x: 0, y: 0, w: 100, h: 100 } });
		const b = marker({ id: "b", region: { x: 400, y: 400, w: 120, h: 120 } });
		const histories = buildAiRegionHistories([a, b]);
		expect(histories).toHaveLength(2);
		expect(histories.every((h) => h.versions.length === 1)).toBe(true);
	});

	it("merges two source-less runs over the IDENTICAL region into one history", () => {
		const a = marker({ id: "a", createdAt: "2026-06-01T00:00:00.000Z" });
		const b = marker({ id: "b", createdAt: "2026-06-01T00:02:00.000Z" });
		const histories = buildAiRegionHistories([a, b]);
		expect(histories).toHaveLength(1);
		expect(histories[0].versions.map((e) => e.marker.id)).toEqual(["a", "b"]);
	});

	it("survives a missing/cyclic source link without crashing", () => {
		const orphan = marker({ id: "orphan", sourceMarkerId: "ghost", region: { x: 5, y: 5, w: 50, h: 50 } });
		const histories = buildAiRegionHistories([orphan]);
		expect(histories).toHaveLength(1);
		expect(histories[0].versions[0].marker.id).toBe("orphan");
	});

	it("locates a marker's history + version", () => {
		const v1 = marker({ id: "v1", createdAt: "2026-06-01T00:00:00.000Z" });
		const v2 = marker({ id: "v2", sourceMarkerId: "v1", createdAt: "2026-06-01T00:05:00.000Z" });
		const histories = buildAiRegionHistories([v1, v2]);
		const found = findAiRegionHistoryForMarker(histories, "v2");
		expect(found?.lineageId).toBe("v1");
		expect(findAiRegionVersion(found, "v2")?.version).toBe(2);
		expect(findAiRegionHistoryForMarker(histories, "missing")).toBeNull();
	});
});
