// Best-effort, IN-SESSION client-ZIP export metering (codex swarm3 c1#1 + re-review P1#2).
//
// Proves the client export path meters usage with an in-session retry instead of
// fire-and-forget, WITHOUT claiming false reload durability:
//   1. A successful single-page (merged) export records usage and marks the run
//      metered (no pending marker).
//   2. A failed recordExportUsage leaves a retryable in-session `meteringPending`
//      marker with the exact, idempotent payload — the export still succeeds + delivers.
//   3. A later export reconciles the pending marker and records it exactly ONCE
//      (idempotent: the stored idempotency key is reused, never double-counted).
//   4. The single-page FALLBACK path (persisted-asset download) now meters too —
//      previously it delivered the file but never recorded usage.
//   5. The pending marker is NOT pushed through `saveProject` (a no-op: `exportRuns`
//      is server-owned + stripped on save), so we never claim a durability we cannot
//      deliver. Reload-durable metering is owned by the server export pipeline (#316).

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { Page, ProjectState } from "$lib/types.js";

vi.mock("$lib/api/client.ts", () => ({
	ApiError: class ApiError extends Error {
		readonly status: number;
		constructor(message: string, status = 500) {
			super(message);
			this.name = "ApiError";
			this.status = status;
		}
	},
	loadProject: vi.fn(),
	saveProject: vi.fn(),
	recordExportUsage: vi.fn(),
	signedImageUrl: vi.fn(async (_projectId: string, imageId: string) => `/signed/${imageId}`),
	// Default: an export token CAN be minted (asset is `passed`) → returns a tokened
	// URL distinct from the input, so the fail-closed export gate passes. Cases that
	// exercise the deny path override this to return the input URL UNCHANGED.
	signedAssetUrl: vi.fn(async (url: string) => `${url}?assetToken=ok`),
	ExportAssetNotAuthorizedError: class ExportAssetNotAuthorizedError extends Error {
		readonly projectId: string;
		readonly imageId: string;
		constructor(projectId: string, imageId: string) {
			super(`Asset ${projectId}/${imageId} is not authorized for export`);
			this.name = "ExportAssetNotAuthorizedError";
			this.projectId = projectId;
			this.imageId = imageId;
		}
	},
	fetchAuthedObjectUrlWithBlob: vi.fn(),
	isApiAssetUrl: vi.fn(() => true),
	imageUrl: vi.fn((projectId: string, imageId: string) => `/api/images/${projectId}/${imageId}`),
}));

function page(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "page-1.webp",
		imageName: "page-1.webp",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "flow208-project",
		name: "Export Metering",
		createdAt: "2026-05-25T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages: [page()],
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
		...overrides,
	};
}

beforeEach(() => {
	projectStore.__resetForTesting();
	vi.clearAllMocks();
	vi.mocked(api.loadProject).mockImplementation(async () => JSON.parse(JSON.stringify(projectStore.project)));
	vi.mocked(api.saveProject).mockResolvedValue(undefined);
	vi.mocked(api.recordExportUsage).mockResolvedValue({
		ok: true,
		eventId: "evt-1",
		usage: {} as never,
	});
});

function mergedEditor() {
	return {
		getAllTextLayers: vi.fn(() => []),
		getAllImageLayers: vi.fn(() => []),
		exportMergedImageDataUrl: vi.fn().mockResolvedValue("data:image/png;base64,AAAA"),
	};
}

describe("ProjectStore best-effort in-session client export metering", () => {
	it("records usage and leaves no pending marker on a successful merged export", async () => {
		projectStore.__setProjectForTesting(project());

		await projectStore.exportPage(mergedEditor());

		expect(api.recordExportUsage).toHaveBeenCalledTimes(1);
		const run = projectStore.exportRuns[0];
		expect(run.status).toBe("done");
		expect(run.meteringPending).toBeFalsy();
		expect(run.meteringRecordedAt).toBeTruthy();
		// The record was bound to this run (run-scoped accounting).
		const [, payload] = vi.mocked(api.recordExportUsage).mock.calls[0];
		expect(payload.exportRunId).toBe(run.id);
		expect(payload.bytes).toBeGreaterThan(0);
	});

	it("leaves a retryable pending marker when recordExportUsage fails, without failing the export", async () => {
		projectStore.__setProjectForTesting(project());
		vi.mocked(api.recordExportUsage).mockRejectedValueOnce(new Error("network down"));

		await projectStore.exportPage(mergedEditor());

		const run = projectStore.exportRuns[0];
		// Export still succeeded + delivered; only metering deferred.
		expect(run.status).toBe("done");
		expect(run.meteringPending).toBe(true);
		expect(run.meteringRecordedAt).toBeFalsy();
		expect(run.meteringInput).toBeTruthy();
		expect(run.meteringInput!.idempotencyKey).toBeTruthy();
		expect(run.meteringInput!.exportRunId).toBe(run.id);
	});

	it("does NOT push the pending marker through saveProject (no false durability claim)", async () => {
		// P1#2: `exportRuns` is server-owned and stripped on save, so persisting the
		// marker via saveState() was a no-op that only risked save-conflict churn. The
		// failure path must leave the in-session marker but must NOT attempt to round-trip
		// it through saveProject as a durable record.
		projectStore.__setProjectForTesting(project());
		vi.mocked(api.recordExportUsage).mockRejectedValueOnce(new Error("network down"));

		await projectStore.exportPage(mergedEditor());

		const run = projectStore.exportRuns[0];
		expect(run.meteringPending).toBe(true);
		// No saveProject call carried a pending metering marker (the export itself does
		// not persist exportRuns either — they are server-owned).
		for (const [, state] of vi.mocked(api.saveProject).mock.calls) {
			const runs = (state as ProjectState).exportRuns ?? [];
			expect(runs.some((r) => r.meteringPending)).toBe(false);
		}
	});

	it("reconciles a pending marker on the next export and records it exactly once (idempotent)", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [page({ imageId: "page-1.webp" }), page({ imageId: "page-2.webp" })],
		}));
		// First export fails to meter -> leaves a pending marker.
		vi.mocked(api.recordExportUsage).mockRejectedValueOnce(new Error("429 throttled"));
		await projectStore.exportPage(mergedEditor());

		const pendingRun = projectStore.exportRuns[0];
		expect(pendingRun.meteringPending).toBe(true);
		const pendingKey = pendingRun.meteringInput!.idempotencyKey;

		// Next export reconciles the pending marker first (succeeds now), then meters
		// the new export.
		vi.mocked(api.recordExportUsage).mockResolvedValue({ ok: true, eventId: "evt", usage: {} as never });
		projectStore.project!.currentPage = 1;
		await projectStore.exportPage(mergedEditor());

		// The reconcile retry reused the SAME idempotency key for the original run.
		const reconcileCall = vi.mocked(api.recordExportUsage).mock.calls.find(
			([, payload]) => payload.idempotencyKey === pendingKey,
		);
		expect(reconcileCall).toBeDefined();

		// The original run is now recorded and no longer pending.
		const recordedRun = projectStore.exportRuns.find((r) => r.id === pendingRun.id)!;
		expect(recordedRun.meteringPending).toBeFalsy();
		expect(recordedRun.meteringRecordedAt).toBeTruthy();

		// No run is left pending.
		expect(projectStore.exportRuns.some((r) => r.meteringPending)).toBe(false);
	});

	it("meters the single-page FALLBACK (persisted-asset) path that previously never metered", async () => {
		// No editor.exportMergedImageDataUrl -> falls through to downloadPageAsset.
		projectStore.__setProjectForTesting(project());
		const blob = new Blob([new Uint8Array(12345)], { type: "image/png" });
		vi.mocked(api.fetchAuthedObjectUrlWithBlob).mockResolvedValue({
			objectUrl: "blob:fake",
			blob,
		});

		await projectStore.exportPage(/* no editor */);

		expect(api.fetchAuthedObjectUrlWithBlob).toHaveBeenCalledTimes(1);
		expect(api.recordExportUsage).toHaveBeenCalledTimes(1);
		const [, payload] = vi.mocked(api.recordExportUsage).mock.calls[0];
		// Bills the REAL delivered byte size.
		expect(payload.bytes).toBe(blob.size);
		expect(payload.exportKind).toBe("single-page");
		const run = projectStore.exportRuns[0];
		expect(run.status).toBe("done");
		expect(run.meteringRecordedAt).toBeTruthy();
	});

	// SECURITY (codex P0): single-page export must FAIL CLOSED for a non-`passed`
	// asset. `signedAssetUrl(...,"export")` returns the URL UNCHANGED when the server
	// refuses to mint an export token (the asset is needs_review/quarantined/blocked or
	// has no passing record). The persisted-asset download path must NOT then fetch the
	// bare URL via the Bearer editor_preview fallback (which the server would serve as
	// the laxer editor_preview purpose) — it must throw + deliver NO bytes.
	it("single-page persisted-asset export FAILS CLOSED (no bytes) when no export token can be minted", async () => {
		projectStore.__setProjectForTesting(project());
		// Server denies the export token → signedAssetUrl returns the input URL unchanged.
		vi.mocked(api.signedAssetUrl).mockImplementation(async (url: string) => url);

		await projectStore.exportPage(/* no editor → persisted-asset path */);

		// FAIL CLOSED: never fetched bytes, never metered, and the run is an error.
		expect(api.fetchAuthedObjectUrlWithBlob).not.toHaveBeenCalled();
		expect(api.recordExportUsage).not.toHaveBeenCalled();
		const run = projectStore.exportRuns[0];
		expect(run.status).toBe("error");
	});

	// SECURITY (codex P0): the LIVE-EDITOR merged export must ALSO be gated
	// server-authoritatively — a non-`passed` current page cannot be exported even
	// though the merged bytes come from the in-memory canvas. We probe the export bar
	// by minting an export token for the page image; when that is denied (signedAssetUrl
	// returns the URL unchanged), we fail closed BEFORE rendering/delivering.
	it("live-editor merged export FAILS CLOSED (no delivery, no metering) for a non-passed page", async () => {
		projectStore.__setProjectForTesting(project());
		vi.mocked(api.signedAssetUrl).mockImplementation(async (url: string) => url);
		const editor = mergedEditor();

		await projectStore.exportPage(editor);

		// The merged render is never even produced, and nothing is metered.
		expect(editor.exportMergedImageDataUrl).not.toHaveBeenCalled();
		expect(api.recordExportUsage).not.toHaveBeenCalled();
		const run = projectStore.exportRuns[0];
		expect(run.status).toBe("error");
	});
});
