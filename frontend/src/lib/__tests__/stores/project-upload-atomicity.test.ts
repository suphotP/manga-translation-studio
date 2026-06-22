import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { aiJobsStore } from "$lib/stores/ai-jobs.svelte.ts";
import type { ProjectState } from "$lib/types.js";

// A valid backend-eligible (UUID) project id so canUseBackendProjectEndpoints() is
// true and the create/fill flows take the real batched-upload + cleanup path.
const CREATED_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const EXISTING_PROJECT_ID = "22222222-2222-4222-8222-222222222222";

vi.mock("$lib/api/client.ts", () => {
	const UPLOAD_TOO_LARGE_MESSAGE = "too large";
	class ApiError extends Error {
		readonly status: number;
		constructor(message: string, status: number) {
			super(message);
			this.name = "ApiError";
			this.status = status;
		}
	}
	return {
		ApiError,
		UPLOAD_TOO_LARGE_MESSAGE,
		isUploadTooLargeError: () => false,
		createProject: vi.fn(),
		deleteProject: vi.fn(),
		uploadImages: vi.fn(),
		loadProject: vi.fn(),
		listProjects: vi.fn(),
		saveProject: vi.fn(),
		// AI single-gen surface — exercised by the create-flow-rollback re-arm test, which
		// seeds a LIVE cover-gen poller for the previous project before the failed create.
		submitAiJob: vi.fn(),
		getAiStatus: vi.fn(),
		cancelAiJob: vi.fn(),
		createAiReviewMarker: vi.fn(),
	};
});

vi.mock("$lib/stores/import-remap.svelte.ts", () => ({
	importRemapStore: { open: vi.fn() },
}));

// A page image File with a deterministic size so the batch planner + fingerprint
// are stable across runs.
function pageFile(name: string): File {
	return new File(["page-bytes"], name, { type: "image/png" });
}

// A FRESH File object that nonetheless carries the SAME name/size/lastModified as a
// prior selection — i.e. a collision twin (re-exported page, equal-size webp, copied
// file). Distinct object identity, identical serializable fingerprint. Used to prove
// the resume guard keys on File IDENTITY, not on the collidable triple.
function collisionTwin(of: File): File {
	const twin = new File(["page-bytes"], of.name, { type: of.type });
	Object.defineProperty(twin, "lastModified", { value: of.lastModified, configurable: true });
	return twin;
}

// Stub the heavy post-upload store tail so a SUCCESSFUL fill/create doesn't need
// the whole save/load/version surface mocked — we only assert upload + cleanup.
function stubPostUploadTail(): void {
	const store = projectStore as unknown as Record<string, any>;
	for (const method of [
		"saveState",
		"loadPage",
		"loadVersions",
		"loadWorkflow",
		"resyncBaselineFromServerAfterCreate",
		"loadComments",
		"loadAiReviewMarkers",
		"loadReviewDecisions",
		"loadWorkspaceHub",
		"loadRecentProjects",
		"loadImageAssets",
		"saveBeforeProjectSwitch",
	]) {
		vi.spyOn(store, method).mockResolvedValue(undefined);
	}
}

function emptyProject(): ProjectState {
	return {
		projectId: EXISTING_PROJECT_ID,
		name: "Existing Empty",
		storyTitle: "Existing Story",
		createdAt: "2026-05-14T00:00:00.000Z",
		currentPage: 0,
		targetLang: "th",
		pages: [],
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
	};
}

// A previous project that already has a page — so loadFilesWithSetup takes the
// brand-new-project create path (and not the empty-project fill redirect) and its
// rollback restores THIS project after a failed create.
function projectWithPage(): ProjectState {
	return {
		...emptyProject(),
		name: "Open With Pages",
		pages: [
			{
				imageId: "existing-page.webp",
				imageName: "existing-page.webp",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			},
		],
	};
}

// Minimal editor for generateCover: a valid cover crop + no-op indicator surface.
// generateThumbnail swallows its own canvas access errors, so canvas can be absent.
function coverEditor() {
	return {
		getCoverCrop: vi.fn(() => ({ x: 0, y: 0, w: 100, h: 100 })),
		getTextLayersInSelection: vi.fn(() => []),
		showProcessingIndicator: vi.fn(),
		updateProcessingIndicator: vi.fn(),
		hideProcessingIndicator: vi.fn(),
		clearCoverSelection: vi.fn(),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	projectStore.__resetForTesting();
	aiJobsStore.__resetForTesting();
	vi.mocked(api.createProject).mockResolvedValue({ projectId: CREATED_PROJECT_ID });
	vi.mocked(api.deleteProject).mockResolvedValue({ ok: true, deleted: true, projectId: CREATED_PROJECT_ID });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("batched upload atomicity (create path)", () => {
	it("deletes the orphan project (and its committed assets) when a later batch fails", async () => {
		stubPostUploadTail();
		// 3 batches of size 1; the SECOND request throws. Batch 1 commits an asset +
		// usage server-side, so without cleanup the new project would be orphaned with
		// one already-metered page.
		let call = 0;
		vi.mocked(api.uploadImages).mockImplementation(async (_projectId, files) => {
			call += 1;
			if (call === 2) throw new Error("network blip on batch 2");
			return { imageIds: files.map((f) => `${f.name}.id`) };
		});

		await projectStore.loadFilesWithSetup(
			[pageFile("p1.png"), pageFile("p2.png"), pageFile("p3.png")],
			null,
			{ projectName: "New Chapter", storyTitle: "Brand New Story", uploadBatchSize: 1, workspaceId: "ws-test" } as any,
		);

		// The orphan project is deleted exactly once, with the backend's confirm rule
		// (storyTitle ?? name) so the type-to-confirm gate accepts it.
		expect(api.deleteProject).toHaveBeenCalledTimes(1);
		expect(api.deleteProject).toHaveBeenCalledWith(CREATED_PROJECT_ID, "Brand New Story");
		// No orphan project is left assigned to the store.
		expect(projectStore.project).toBeNull();
	});

	it("does not delete the project when every batch uploads cleanly", async () => {
		stubPostUploadTail();
		vi.mocked(api.uploadImages).mockImplementation(async (_projectId, files) => ({
			imageIds: files.map((f) => `${f.name}.id`),
		}));

		await projectStore.loadFilesWithSetup(
			[pageFile("p1.png"), pageFile("p2.png"), pageFile("p3.png")],
			null,
			{ projectName: "New Chapter", storyTitle: "Brand New Story", uploadBatchSize: 1, workspaceId: "ws-test" } as any,
		);

		expect(api.deleteProject).not.toHaveBeenCalled();
		expect(projectStore.project?.projectId).toBe(CREATED_PROJECT_ID);
		expect(projectStore.project?.pages.map((p) => p.imageId)).toEqual([
			"p1.png.id",
			"p2.png.id",
			"p3.png.id",
		]);
	});
});

describe("batched upload atomicity (fill-existing path)", () => {
	it("resumes a failed fill without re-uploading the committed pages on retry", async () => {
		stubPostUploadTail();
		const files = [pageFile("a.png"), pageFile("b.png"), pageFile("c.png"), pageFile("d.png")];

		// First attempt: batch size 2 → [a,b] commits, [c,d] throws.
		const firstUploaded: string[][] = [];
		vi.mocked(api.uploadImages).mockImplementation(async (_projectId, batch) => {
			firstUploaded.push(batch.map((f) => f.name));
			if (batch[0].name === "c.png") throw new Error("boom on batch 2");
			return { imageIds: batch.map((f) => `${f.name}.id`) };
		});

		projectStore.__setProjectForTesting(emptyProject());
		await projectStore.fillEmptyProjectWithPages(files, null, { uploadBatchSize: 2 } as any);
		expect(firstUploaded).toEqual([["a.png", "b.png"], ["c.png", "d.png"]]);
		// Failure reset the project back to empty so the retry's zero-page guard passes.
		expect(projectStore.project?.pages.length).toBe(0);

		// Retry the SAME selection: committed pages a,b must NOT be re-uploaded (no
		// double-metering); only c,d are sent this time.
		const retryUploaded: string[][] = [];
		vi.mocked(api.uploadImages).mockImplementation(async (_projectId, batch) => {
			retryUploaded.push(batch.map((f) => f.name));
			return { imageIds: batch.map((f) => `${f.name}.id`) };
		});
		await projectStore.fillEmptyProjectWithPages(files, null, { uploadBatchSize: 2 } as any);

		expect(retryUploaded).toEqual([["c.png", "d.png"]]);
		// The produced project is the full ordered set, identical to an uninterrupted run.
		expect(projectStore.project?.pages.map((p) => p.imageId)).toEqual([
			"a.png.id",
			"b.png.id",
			"c.png.id",
			"d.png.id",
		]);
		// An existing project is never deleted on the fill path.
		expect(api.deleteProject).not.toHaveBeenCalled();
	});

	it("discards the resume stash when the retry uses a different selection", async () => {
		stubPostUploadTail();
		const original = [pageFile("a.png"), pageFile("b.png"), pageFile("c.png"), pageFile("d.png")];

		vi.mocked(api.uploadImages).mockImplementation(async (_projectId, batch) => {
			if (batch[0].name === "c.png") throw new Error("boom");
			return { imageIds: batch.map((f) => `${f.name}.id`) };
		});
		projectStore.__setProjectForTesting(emptyProject());
		await projectStore.fillEmptyProjectWithPages(original, null, { uploadBatchSize: 2 } as any);

		// Retry with a DIFFERENT selection — the stale resume must be ignored so the
		// new selection uploads from scratch (every page, in the new order).
		const reUploaded: string[][] = [];
		vi.mocked(api.uploadImages).mockImplementation(async (_projectId, batch) => {
			reUploaded.push(batch.map((f) => f.name));
			return { imageIds: batch.map((f) => `${f.name}.id`) };
		});
		const changed = [pageFile("x.png"), pageFile("y.png")];
		await projectStore.fillEmptyProjectWithPages(changed, null, { uploadBatchSize: 2 } as any);

		expect(reUploaded).toEqual([["x.png", "y.png"]]);
		expect(projectStore.project?.pages.map((p) => p.imageId)).toEqual(["x.png.id", "y.png.id"]);
	});

	// P1 regression (codex round-3): the resume guard must key on in-memory File
	// IDENTITY, NOT a name+size+lastModified fingerprint. Two genuinely different
	// selections whose leading files COLLIDE on that triple (re-exported pages,
	// equal-size webp, copied files) must NOT reuse the stale committed prefix — doing
	// so would skip files never uploaded for THIS selection (missing/wrong pages) or
	// attach the wrong committed ids. Fail-safe: any doubt = full clean re-upload.
	it("does NOT reuse a stale stash for a fingerprint-colliding but DIFFERENT selection", async () => {
		stubPostUploadTail();
		// First attempt commits [a,b] then fails on [c,d].
		const first = [pageFile("a.png"), pageFile("b.png"), pageFile("c.png"), pageFile("d.png")];
		vi.mocked(api.uploadImages).mockImplementation(async (_projectId, batch) => {
			if (batch[0].name === "c.png") throw new Error("boom on batch 2");
			return { imageIds: batch.map((f) => `${f.name}.id`) };
		});
		projectStore.__setProjectForTesting(emptyProject());
		await projectStore.fillEmptyProjectWithPages(first, null, { uploadBatchSize: 2 } as any);
		expect(projectStore.project?.pages.length).toBe(0);

		// Retry with a SECOND, genuinely different selection (NEW File objects) whose
		// leading pages are collision twins of the committed prefix a,b (same name,
		// size, lastModified) but whose later pages differ. If the guard trusted the
		// fingerprint it would skip a,b and attach the FIRST selection's a.id/b.id —
		// wrong/missing pages. With identity it re-uploads everything fresh.
		const colliding = [collisionTwin(first[0]), collisionTwin(first[1]), pageFile("e.png"), pageFile("f.png")];
		const retryUploaded: string[][] = [];
		vi.mocked(api.uploadImages).mockImplementation(async (_projectId, batch) => {
			retryUploaded.push(batch.map((f) => f.name));
			return { imageIds: batch.map((f) => `${f.name}.id`) };
		});
		await projectStore.fillEmptyProjectWithPages(colliding, null, { uploadBatchSize: 2 } as any);

		// Every page of the NEW selection is uploaded (nothing skipped), in order.
		expect(retryUploaded).toEqual([["a.png", "b.png"], ["e.png", "f.png"]]);
		expect(projectStore.project?.pages.map((p) => p.imageId)).toEqual([
			"a.png.id",
			"b.png.id",
			"e.png.id",
			"f.png.id",
		]);
		expect(api.deleteProject).not.toHaveBeenCalled();
	});

	// The happy/identity path: the SAME File objects (e.g. the dialog's unchanged
	// `imageFiles`) retried after a partial failure DO resume, even when a separate
	// re-ordering pass (orderProjectImageFiles) hands the store a fresh array — the
	// per-element File identity still holds, so committed pages are not re-uploaded.
	it("resumes when the retry passes the SAME File objects in a fresh array", async () => {
		stubPostUploadTail();
		const fileA = pageFile("a.png");
		const fileB = pageFile("b.png");
		const fileC = pageFile("c.png");
		const fileD = pageFile("d.png");

		vi.mocked(api.uploadImages).mockImplementation(async (_projectId, batch) => {
			if (batch[0].name === "c.png") throw new Error("boom on batch 2");
			return { imageIds: batch.map((f) => `${f.name}.id`) };
		});
		projectStore.__setProjectForTesting(emptyProject());
		await projectStore.fillEmptyProjectWithPages([fileA, fileB, fileC, fileD], null, { uploadBatchSize: 2 } as any);
		expect(projectStore.project?.pages.length).toBe(0);

		// A brand-new array, but the SAME File objects → identity holds → resume.
		const retryUploaded: string[][] = [];
		vi.mocked(api.uploadImages).mockImplementation(async (_projectId, batch) => {
			retryUploaded.push(batch.map((f) => f.name));
			return { imageIds: batch.map((f) => `${f.name}.id`) };
		});
		await projectStore.fillEmptyProjectWithPages([fileA, fileB, fileC, fileD], null, { uploadBatchSize: 2 } as any);

		// Committed a,b skipped; only c,d re-sent.
		expect(retryUploaded).toEqual([["c.png", "d.png"]]);
		expect(projectStore.project?.pages.map((p) => p.imageId)).toEqual([
			"a.png.id",
			"b.png.id",
			"c.png.id",
			"d.png.id",
		]);
	});
});

// Round 11 FINDING 1 (P2): during the brand-new-project create flow the new project is
// ASSIGNED early (fireHooks deferred) so the steps build against it — but the PREVIOUS
// project's poll intervals keep running. Each tick now fails isProjectContextCurrent (the
// open id is the NEW one) and SELF-CLEARS its own interval, leaving the previous project's
// still-running rows processing-but-UNPOLLED. If a later create step throws, the catch
// rolls back to the previous project; without a re-arm those rows would sit forever with
// no poller. The fix re-arms them on the rollback path via the resumePolling machinery.
describe("create-flow rollback re-arms the restored project's AI polls (round 11 FINDING 1)", () => {
	async function flushMicrotasks(times = 6): Promise<void> {
		for (let i = 0; i < times; i++) await Promise.resolve();
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it("a failed create re-arms a LIVE poller for the previous project's running cover job", async () => {
		vi.useFakeTimers();
		stubPostUploadTail();
		const mockEditor = coverEditor();

		// Open a project that has a page and seed a LIVE single-gen cover poller for it.
		projectStore.__setProjectForTesting(projectWithPage());
		vi.spyOn(projectStore, "syncTextLayers").mockImplementation(() => {});
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		// saveState resolves for the seeding generateCover; the create flow's saveState is
		// held open (below) so a poll tick can fire DURING the create window, then rejected.
		const saveState = projectStore.saveState as unknown as ReturnType<typeof vi.fn>;
		saveState.mockResolvedValueOnce(undefined);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "cover-job-1", prompt: "p", tier: "sfx-pro" } as any);
		// The job stays PROCESSING throughout the window; we flip it to done AFTER the rollback.
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" } as any);

		await aiJobsStore.generateCover(mockEditor, "Clean the panel");
		await flushMicrotasks();

		// The previous project now has exactly one processing cover row with a live poller.
		expect(aiJobsStore.activeJobs).toHaveLength(1);
		const seededRow = aiJobsStore.activeJobs[0];
		expect(seededRow.status).toBe("processing");
		expect(seededRow.remoteJobId).toBe("cover-job-1");

		// Run the create flow for a BRAND-NEW project. createProject + uploadImages succeed,
		// so the new project is ASSIGNED (deferred-hook, fireHooks:false) and becomes the open
		// id. We HOLD the create flow's saveState open at that exact point: this is the window
		// where the previous project's poll ticks now fail isProjectContextCurrent. We advance
		// a poll interval inside the window so the seeded poller actually TICKS and SELF-CLEARS
		// its interval (clearInterval + pendingJobs.delete) — reproducing the real bug. THEN we
		// reject saveState so the catch rolls back to the previous project; the row is now
		// processing-but-unpolled, and the rollback re-arm must give it a live poller again.
		vi.mocked(api.uploadImages).mockResolvedValue({ imageIds: ["np1.png.id"] } as any);
		let rejectSave!: (e: unknown) => void;
		saveState.mockReturnValueOnce(new Promise<void>((_resolve, reject) => { rejectSave = reject; }));

		const createFlow = projectStore.loadFilesWithSetup(
			[pageFile("np1.png")],
			mockEditor,
			{ projectName: "New Chapter", storyTitle: "New Story", workspaceId: "ws-test" } as any,
		);
		// Drain up to the (held) create-flow saveState: the new project is now assigned/open.
		await flushMicrotasks();
		expect(projectStore.project?.projectId).toBe(CREATED_PROJECT_ID);

		// Tick a poll interval IN the window: the seeded poller sees the NEW open id, fails its
		// context guard, and self-clears — the row is now processing with NO interval.
		await vi.advanceTimersByTimeAsync(2000);
		await flushMicrotasks();
		expect(aiJobsStore.queueStats.processing).toBe(1);

		// Now fail the create: the catch rolls back to the previous project AND re-arms.
		rejectSave(new Error("save blew up after assign"));
		await createFlow;
		await flushMicrotasks();

		// Rollback restored the previous project (NOT the half-created one).
		expect(projectStore.project?.projectId).toBe(EXISTING_PROJECT_ID);
		// The seeded cover row survived (its backend job is still real) and is still processing.
		const restoredRow = aiJobsStore.activeJobs.find((j) => j.remoteJobId === "cover-job-1");
		expect(restoredRow?.status).toBe("processing");

		// Prove the poller is LIVE again: flip the backend to done, advance one poll interval,
		// and the re-armed tick must observe it and drive the row to a terminal status. Without
		// the rollback re-arm the self-cleared interval is gone, getAiStatus is never called
		// again, and the row would stay processing forever.
		vi.mocked(api.getAiStatus).mockClear();
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "done", resultImageId: "result-1" } as any);

		await vi.advanceTimersByTimeAsync(2000);
		await flushMicrotasks();

		// The re-armed poller hit the backend (live interval) and advanced the row off processing.
		expect(api.getAiStatus).toHaveBeenCalledWith("cover-job-1");
		const finalRow = aiJobsStore.queueStats;
		expect(finalRow.processing).toBe(0);
		expect(finalRow.needsReview + finalRow.done).toBeGreaterThanOrEqual(1);
	});

	it("the previous project's running poll SELF-CLEARS during the create window (the bug the re-arm heals)", async () => {
		// Demonstrates the underlying hazard the re-arm fixes: while the new project is the
		// open one (mid-create), the previous project's poll tick fails isProjectContext-
		// Current and self-clears its interval — so absent the rollback re-arm the row would
		// be left unpolled. (Here we DON'T roll back; we just observe the self-clear.)
		vi.useFakeTimers();
		const mockEditor = coverEditor();

		projectStore.__setProjectForTesting(projectWithPage());
		vi.spyOn(projectStore, "syncTextLayers").mockImplementation(() => {});
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "cover-job-2", prompt: "p", tier: "sfx-pro" } as any);
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" } as any);

		await aiJobsStore.generateCover(mockEditor, "Clean the panel");
		await flushMicrotasks();
		expect(aiJobsStore.activeJobs).toHaveLength(1);

		// Simulate the mid-create window: the NEW project is now the open one.
		projectStore.__setProjectForTesting({ ...projectWithPage(), projectId: CREATED_PROJECT_ID });
		vi.mocked(api.getAiStatus).mockClear();

		// One poll interval: the tick sees a different open id, self-clears, and does NOT
		// re-poll on subsequent intervals.
		await vi.advanceTimersByTimeAsync(2000);
		await flushMicrotasks();
		const callsAfterFirst = vi.mocked(api.getAiStatus).mock.calls.length;
		await vi.advanceTimersByTimeAsync(2000);
		await flushMicrotasks();
		// No further polls after the self-clear: the interval is gone (unpolled row).
		expect(vi.mocked(api.getAiStatus).mock.calls.length).toBe(callsAfterFirst);
	});

	it("round 13 FINDING 1: a row DISCARDED mid-create-window is RESTORED on rollback (not orphaned)", async () => {
		// The harder FINDING-1 case: not just a self-clearing poll, but a batch submit
		// CONTINUATION that resolves DURING the create window. At that point this.project is
		// already the NEW id, so discardSwitchedAwayJob sees "switched away" and DROPS the
		// batch row (releasing its slot) while still writing the owner's server marker. Before
		// the fix, the rollback's runResumePolling could only re-arm SURVIVING rows, so the
		// accepted+charged job was orphaned/invisible. The snapshot/restore seam re-inserts the
		// discarded row (from a pre-flip snapshot) BEFORE resume, so it is visible again and the
		// slot invariant is restored.
		vi.useFakeTimers();
		stubPostUploadTail();
		const mockEditor = coverEditor();

		projectStore.__setProjectForTesting(projectWithPage());
		vi.spyOn(projectStore, "syncTextLayers").mockImplementation(() => {});
		const createMarker = vi
			.spyOn(projectStore, "createAiReviewMarker")
			.mockResolvedValue({ id: "marker-batch-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);

		// Hold the BATCH submit open so its continuation resolves AFTER the create flip.
		let resolveSubmit!: (v: unknown) => void;
		vi.mocked(api.submitAiJob).mockReturnValue(
			new Promise((resolve) => { resolveSubmit = resolve; }) as any,
		);
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" } as any);

		// Seed a batch job for project A: it reaches `processing` + holds a concurrency slot,
		// then BLOCKS on the held submit (no remoteJobId yet, submit in flight).
		void aiJobsStore.addBatchJobs(mockEditor, [{ x: 0, y: 0, w: 100, h: 100 }]);
		await flushMicrotasks();
		expect(aiJobsStore.queueStats.processing).toBe(1);
		aiJobsStore.__assertSlotInvariant();

		// Run the create flow; createProject + uploadImages succeed → the new project is
		// ASSIGNED (snapshot of A's rows is taken just before the flip). Hold its saveState.
		vi.mocked(api.uploadImages).mockResolvedValue({ imageIds: ["np1.png.id"] } as any);
		let rejectSave!: (e: unknown) => void;
		const saveState = projectStore.saveState as unknown as ReturnType<typeof vi.fn>;
		saveState.mockReturnValueOnce(new Promise<void>((_resolve, reject) => { rejectSave = reject; }));

		const createFlow = projectStore.loadFilesWithSetup(
			[pageFile("np1.png")],
			mockEditor,
			{ projectName: "New Chapter", storyTitle: "New Story", workspaceId: "ws-test" } as any,
		);
		await flushMicrotasks();
		expect(projectStore.project?.projectId).toBe(CREATED_PROJECT_ID);

		// Resolve the batch submit IN the window: the continuation sees the NEW open id,
		// discards A's row (slot released → count 0), and writes the owner's server marker.
		resolveSubmit({ jobId: "batch-job-1", tier: "sfx-pro" });
		await flushMicrotasks();
		// The row is GONE during the window and the owner marker was written for the charged job.
		expect(aiJobsStore.queue.some((j) => j.projectId === EXISTING_PROJECT_ID)).toBe(false);
		expect(createMarker).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: "batch-job-1" }),
			expect.objectContaining({ forProjectId: EXISTING_PROJECT_ID }),
		);

		// Fail the create → rollback. restoreMissingRows re-inserts A's discarded row, then
		// runResumePolling runs. Without the snapshot/restore seam the row stays orphaned.
		rejectSave(new Error("save blew up after assign"));
		await createFlow;
		await flushMicrotasks();

		expect(projectStore.project?.projectId).toBe(EXISTING_PROJECT_ID);
		// The discarded row is RESTORED (visible again), in its snapshotted processing state.
		const restored = aiJobsStore.queue.filter((j) => j.projectId === EXISTING_PROJECT_ID);
		expect(restored).toHaveLength(1);
		expect(restored[0].status).toBe("processing");
		// Slot accounting is restored alongside the row (the snapshot carried holdsBatchSlot).
		aiJobsStore.__assertSlotInvariant();
		expect(aiJobsStore.queueStats.processing).toBe(1);
	});

	it("round 13 FINDING 1: a restored row that CARRIES a remoteJobId is RE-ARMED by resume", async () => {
		// restoreMissingRows re-inserts WITHOUT arming intervals; the create-flow rollback
		// runs runResumePolling right after, which re-arms every still-running row of the
		// restored project — including a restored row that already carries a remoteJobId. This
		// pins the "resume re-arms the restored rows too" half of the fix at the seam level.
		vi.useFakeTimers();
		const restored = projectWithPage();
		projectStore.__setProjectForTesting(restored);

		// A snapshot row for the open project, carrying a remoteJobId (its submit had resolved
		// before it was dropped). It is NOT in the live queue (it was discarded mid-window).
		const snapshotRow = {
			id: "snap-row-1",
			projectId: EXISTING_PROJECT_ID,
			imageId: "existing-page.webp",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "p",
			thumbnail: "",
			status: "processing" as const,
			stage: "processing" as const,
			progress: 30,
			tier: "sfx-pro" as const,
			remoteJobId: "resumable-job-1",
			pageIndex: 0,
			createdAt: Date.now(),
		};
		expect(aiJobsStore.queue.find((j) => j.id === "snap-row-1")).toBeUndefined();

		// Restore then resume (the exact rollback ordering: restore BEFORE resume).
		aiJobsStore.restoreMissingRows([snapshotRow as any]);
		expect(aiJobsStore.queue.find((j) => j.id === "snap-row-1")).toBeDefined();

		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "done", resultImageId: "result-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		aiJobsStore.resumePolling(coverEditor());

		// The re-armed poll hits the backend on the next interval and drives the row terminal.
		await vi.advanceTimersByTimeAsync(2000);
		await flushMicrotasks();
		expect(api.getAiStatus).toHaveBeenCalledWith("resumable-job-1");
		expect(aiJobsStore.queueStats.processing).toBe(0);
	});
});
