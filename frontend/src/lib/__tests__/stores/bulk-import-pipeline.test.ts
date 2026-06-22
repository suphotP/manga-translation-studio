import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { ProjectState } from "$lib/types.js";

// Regression tests for the upload-pipeline reliability fixes (fix/upload-pipeline-
// reliability):
//   P0 — bulk-import KEEP mode now goes through the batched/XHR-progress machinery
//        so the dialog shows a real advancing bar (progress callbacks invoked) and
//        never relies on one opaque 180s mega-request.
//   P1 — a mid-batch KEEP failure reconciles the already-committed prefix into local
//        + server state (no orphaned billed pages) and stashes it so a same-session
//        retry RESUMES from the failed batch instead of re-uploading / double-importing.

const projectId = "11111111-1111-4111-8111-111111111111";

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId,
		name: "Bulk import pipeline",
		createdAt: "2026-06-07T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages: [],
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
		...overrides,
	};
}

function pngFile(name: string): File {
	return new File([new Uint8Array([1, 2, 3, 4])], name, { type: "image/png" });
}

function asset(imageId: string): api.ProjectImageAssetSummary {
	return {
		assetId: imageId,
		imageId,
		originalName: imageId,
		mimeType: "image/png",
		sizeBytes: 4,
		sha256: imageId,
		storageDriver: "local",
		storageKey: `projects/${projectId}/images/${imageId}`,
		width: 100,
		height: 150,
		storageStatus: "released",
		moderationStatus: "passed",
		derivativeCount: 0,
		createdAt: "2026-06-07T00:00:00.000Z",
		updatedAt: "2026-06-07T00:00:00.000Z",
	};
}

function uploadResult(imageIds: string[]): api.UploadImagesResult {
	return { imageIds, assets: imageIds.map(asset) };
}

// Stub the post-upload persistence/refresh side effects so the test never hits the
// network; they are exercised by their own suites.
function stubSideEffects() {
	vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined as never);
	vi.spyOn(projectStore, "loadImageAssets").mockResolvedValue(undefined as never);
	vi.spyOn(projectStore, "loadRecentProjects").mockResolvedValue(undefined as never);
	vi.spyOn(projectStore, "loadPage").mockResolvedValue(undefined as never);
}

beforeEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	projectStore.__resetForTesting();
});

describe("bulk-import KEEP mode batches with real progress", () => {
	it("splits a large keep-mode selection into batches and reports advancing progress", async () => {
		projectStore.__setProjectForTesting(project());
		stubSideEffects();

		const files = Array.from({ length: 30 }, (_, i) => pngFile(`page-${i + 1}.png`));
		const batches: string[][] = [];
		const transform = vi
			.spyOn(api, "uploadImagesTransformed")
			.mockImplementation(async (_projectId, batch, mode, _options, onProgress) => {
				expect(mode).toBe("keep");
				batches.push(batch.map((f) => f.name));
				// Drive the byte-progress callback so the store updates its bar.
				onProgress?.(0.5);
				onProgress?.(1);
				return uploadResult(batch.map((f) => `${f.name}.id`));
			});

		const added = await projectStore.bulkImportPages(files, "keep", null);

		// More than one batch (DEFAULT batch size is 12) → real batching, not one
		// opaque mega-request.
		expect(transform.mock.calls.length).toBeGreaterThan(1);
		expect(batches.flat()).toEqual(files.map((f) => f.name));
		// Per-batch onProgress was provided + invoked (XHR-progress machinery wired).
		expect(transform.mock.calls.every((call) => typeof call[4] === "function")).toBe(true);
		expect(added).toBe(30);
		expect(projectStore.project?.pages.length).toBe(30);
	});
});

describe("bulk-import KEEP mid-batch failure reconciles + resumes (no orphans / no double-import)", () => {
	it("commits the first batch into local state on failure, then resumes the rest on retry", async () => {
		projectStore.__setProjectForTesting(project());
		stubSideEffects();

		const files = Array.from({ length: 18 }, (_, i) => pngFile(`p-${i + 1}.png`));

		// First attempt: batch 1 (12 files) succeeds, batch 2 throws.
		let call = 0;
		vi.spyOn(api, "uploadImagesTransformed").mockImplementation(async (_p, batch) => {
			call += 1;
			if (call === 1) return uploadResult(batch.map((f) => `${f.name}.id`));
			throw new Error("Service Unavailable");
		});

		const firstAttempt = await projectStore.bulkImportPages(files, "keep", null);

		// The committed first batch is reconciled into local state (NOT orphaned):
		// returned count + appended pages reflect the 12 committed pages.
		expect(firstAttempt).toBe(12);
		expect(projectStore.project?.pages.length).toBe(12);
		const committedIds = projectStore.project?.pages.map((page) => page.imageId) ?? [];
		expect(committedIds).toEqual(files.slice(0, 12).map((f) => `${f.name}.id`));

		// Second attempt (same File objects): resumes from the committed prefix — the
		// first 12 are NOT re-uploaded, only the remaining 6 are sent.
		const retryBatches: string[][] = [];
		vi.spyOn(api, "uploadImagesTransformed").mockImplementation(async (_p, batch) => {
			retryBatches.push(batch.map((f) => f.name));
			return uploadResult(batch.map((f) => `${f.name}.id`));
		});

		const retry = await projectStore.bulkImportPages(files, "keep", null);

		// Only the previously-uncommitted tail is re-sent (resume skipped the prefix).
		expect(retryBatches.flat()).toEqual(files.slice(12).map((f) => f.name));
		expect(retry).toBe(6);
		// Total pages == all 18, with NO duplicates (committed prefix not re-appended).
		expect(projectStore.project?.pages.length).toBe(18);
		const allIds = projectStore.project?.pages.map((page) => page.imageId) ?? [];
		expect(new Set(allIds).size).toBe(18);
		expect(allIds).toEqual(files.map((f) => `${f.name}.id`));
	});
});

describe("bulk-import KEEP single-batch lost-response (canonical P1) replays the SAME key on retry", () => {
	it("retries the failed FIRST/only batch with its ORIGINAL idempotency key so the server replays (no dup, no orphan)", async () => {
		projectStore.__setProjectForTesting(project());
		stubSideEffects();

		// A SINGLE batch (< DEFAULT batch size of 12) — this is the canonical P1: the
		// only batch commits server-side, then the XHR loses the response (onerror/
		// ontimeout) and THROWS, so committedFiles === 0. The committed assets are
		// server-side but invisible to the client. The retry MUST re-send the SAME
		// idempotency key so the backend replays the committed result instead of
		// re-committing (which would duplicate assets + orphan the first commit).
		const files = Array.from({ length: 5 }, (_, i) => pngFile(`solo-${i + 1}.png`));

		// First attempt: capture the key the only batch used, then throw AS IF the
		// commit succeeded server-side but the response was lost.
		let firstKey: string | undefined;
		let firstCallCount = 0;
		vi.spyOn(api, "uploadImagesTransformed").mockImplementation(
			async (_p, _batch, _mode, _options, _onProgress, idempotencyKey) => {
				firstCallCount += 1;
				firstKey = idempotencyKey;
				throw new Error("network dropped after commit");
			},
		);

		const firstAttempt = await projectStore.bulkImportPages(files, "keep", null);

		// Only one batch was attempted and it failed; nothing is visible locally yet
		// (committedFiles === 0 → no reconcile), so the count is 0 and no pages added.
		expect(firstCallCount).toBe(1);
		expect(firstKey).toBeTruthy();
		expect(firstAttempt).toBe(0);
		expect(projectStore.project?.pages.length).toBe(0);

		// Retry (SAME File objects): the failed batch MUST be re-sent with the SAME
		// key. The mock now simulates the backend's idempotent replay returning the
		// originally-committed ids.
		const retryKeys: Array<string | undefined> = [];
		const retryBatches: string[][] = [];
		vi.spyOn(api, "uploadImagesTransformed").mockImplementation(
			async (_p, batch, _mode, _options, _onProgress, idempotencyKey) => {
				retryKeys.push(idempotencyKey);
				retryBatches.push(batch.map((f) => f.name));
				return uploadResult(batch.map((f) => `${f.name}.id`));
			},
		);

		const retry = await projectStore.bulkImportPages(files, "keep", null);

		// The retry re-sent exactly one batch (all 5 files) with the ORIGINAL key —
		// this is what makes the server replay rather than re-commit.
		expect(retryKeys.length).toBe(1);
		expect(retryKeys[0]).toBe(firstKey);
		expect(retryBatches).toEqual([files.map((f) => f.name)]);
		// The replayed commit yields exactly the 5 pages, with NO duplicates and NO
		// orphan (the same imageIds the original lost-but-committed response held).
		expect(retry).toBe(5);
		expect(projectStore.project?.pages.length).toBe(5);
		const ids = projectStore.project?.pages.map((page) => page.imageId) ?? [];
		expect(new Set(ids).size).toBe(5);
		expect(ids).toEqual(files.map((f) => `${f.name}.id`));
	});
});
