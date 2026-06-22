import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "$lib/api/client.ts";
import { config } from "$lib/config.js";
import { aiJobsStore } from "$lib/stores/ai-jobs.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { AiReviewMarker, Page, ProjectState } from "$lib/types.js";

vi.mock("$lib/api/client.ts", () => ({
	submitAiJob: vi.fn(),
	rerunAiReviewMarker: vi.fn(),
	getAiStatus: vi.fn(),
	cancelAiJob: vi.fn(),
	// FINDING 1: a submit that resolves after a switch must still write the marker
	// against the OWNER's projectId (bypassing projectStore's local-mutating wrapper).
	// projectStore.createAiReviewMarker is spied per-test; this raw client fn is mocked
	// so any code path that reaches the client layer in a non-spied test does not throw.
	createAiReviewMarker: vi.fn(),
}));

// FINDING 1 (round 6): the sign-out wipe is registered at the STORE level via a lazy
// dynamic import of authStore — NOT statically — precisely so auth's module side effect
// (api.setAuthRefreshHandler, which this file's api mock deliberately does NOT stub)
// stays out of the store's static import graph. We mock the auth module here so the
// dynamic import in registerSignOutCleanup resolves to a minimal stub that just captures
// the registered pre-sign-out hook; the test then fires it to simulate a real sign-out.
// (The fact that the api mock omits setAuthRefreshHandler is the test-mock EVIDENCE that
// a static `import { authStore }` would break this suite — proving the lazy seam.)
const preSignOutHooks: Array<() => void | Promise<void>> = [];
vi.mock("$lib/stores/auth.svelte.ts", () => ({
	authStore: {
		registerPreSignOut(hook: () => void | Promise<void>) {
			preSignOutHooks.push(hook);
			return () => {
				const i = preSignOutHooks.indexOf(hook);
				if (i >= 0) preSignOutHooks.splice(i, 1);
			};
		},
	},
}));

async function runSignOutHooks(): Promise<void> {
	for (const hook of [...preSignOutHooks]) await hook();
}

const now = "2026-05-14T12:00:00.000Z";

function page(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "image-1.webp",
		imageName: "image-1.webp",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "project-1",
		name: "AI runtime test",
		createdAt: now,
		pages: [page()],
		currentPage: 0,
		targetLang: "th",
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: [],
		reviewDecisions: [],
		workspaceMessages: [],
		...overrides,
	};
}

function editor() {
	return {
		getCoverCrop: vi.fn(() => ({ x: 0, y: 0, w: 100, h: 100 })),
		getTextLayersInSelection: vi.fn(() => []),
		showProcessingIndicator: vi.fn(),
		updateProcessingIndicator: vi.fn(),
		hideProcessingIndicator: vi.fn(),
		clearCoverSelection: vi.fn(),
		updateBackgroundImage: vi.fn(),
	};
}

function marker(overrides: Partial<AiReviewMarker> = {}): AiReviewMarker {
	return {
		id: "marker-1",
		jobId: "job-old",
		pageIndex: 0,
		imageId: "image-1.webp",
		region: { x: 10, y: 12, w: 120, h: 80 },
		status: "retry_requested",
		tier: "sfx-pro",
		prompt: "old generated prompt",
		customPrompt: "Preserve the impact lettering",
		textLayers: ["BOOM", "small aside"],
		translateSfx: false,
		linkedCommentIds: ["comment-1"],
		linkedTaskIds: ["task-1"],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

beforeEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	preSignOutHooks.length = 0;
	aiJobsStore.__resetForTesting();
	projectStore.__resetForTesting();
	projectStore.__setProjectForTesting(project());
	vi.spyOn(projectStore, "syncTextLayers").mockImplementation(() => {});
});

describe("AiJobsStore runtime error handling", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("cleans up the uploading indicator when the pre-submit save fails", async () => {
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockRejectedValue(new Error("Save failed: disk is full"));

		await aiJobsStore.generateCover(mockEditor);

		expect(api.submitAiJob).not.toHaveBeenCalled();
		expect(aiJobsStore.queue).toEqual([]);
		expect(mockEditor.hideProcessingIndicator).toHaveBeenCalledWith(expect.stringMatching(/^temp-/));
		expect(projectStore.statusMsg).toBe("AI ยังไม่เริ่ม: Save failed: disk is full");
	});

	it("cleans up the uploading indicator and shows a SAFE message when the provider rejects (no key leak)", async () => {
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		// This raw provider error mentions "API key" — it must be mapped to a
		// friendly message, never surfaced verbatim (security: no key/prompt leak).
		vi.mocked(api.submitAiJob).mockRejectedValue(
			new Error("Clean Pro requires OpenRouter to be enabled with an API key."),
		);

		await aiJobsStore.generateCover(mockEditor);

		expect(aiJobsStore.queue).toEqual([]);
		expect(mockEditor.hideProcessingIndicator).toHaveBeenCalledWith(expect.stringMatching(/^temp-/));
		expect(projectStore.statusMsg).toBe("บริการ AI ยังไม่พร้อม (ตั้งค่าคีย์ไม่ถูกต้อง) แจ้งผู้ดูแลระบบ");
		expect(projectStore.statusMsg).not.toContain("API key");
		expect(projectStore.statusMsg).not.toContain("OpenRouter");
	});

	it("starts polling after backend acceptance even while marker creation is still pending", async () => {
		vi.useFakeTimers();
		const mockEditor = editor();
		mockEditor.getTextLayersInSelection.mockReturnValue(["SFX: boom", "aside"]);
		let resolveMarker!: (marker: any) => void;
		const markerPromise = new Promise<any>((resolve) => {
			resolveMarker = resolve;
		});
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockReturnValue(markerPromise);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.spyOn(projectStore, "applyAiResult").mockResolvedValue(undefined);
		vi.mocked(api.submitAiJob).mockResolvedValue({
			jobId: "job-1",
			prompt: "prompt",
			tier: "sfx-pro",
		});
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		await aiJobsStore.generateCover(mockEditor, "Preserve original sound effect style");

		expect(projectStore.createAiReviewMarker).toHaveBeenCalled();
		// The marker is now created with an explicit forProjectId (the owner captured
		// before the submit await) so a switch mid-await can't bleed it into another
		// project (FINDING 1/2).
		expect(projectStore.createAiReviewMarker).toHaveBeenCalledWith(
			expect.objectContaining({
				customPrompt: "Preserve original sound effect style",
				textLayers: ["SFX: boom", "aside"],
				translateSfx: true,
			}),
			expect.objectContaining({ forProjectId: "project-1" }),
		);
		expect(aiJobsStore.queue[0]).toMatchObject({
			id: "job-1",
			status: "processing",
			stage: "processing",
			progress: 30,
		});
		expect(mockEditor.updateProcessingIndicator).toHaveBeenCalledWith(
			expect.stringMatching(/^temp-/),
			"processing",
		);

		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);

		expect(api.getAiStatus).toHaveBeenCalledWith("job-1");
		expect(aiJobsStore.queue[0]).toMatchObject({
			id: "job-1",
			status: "processing",
			stage: "processing",
		});

		resolveMarker({ id: "marker-1" });
		await Promise.resolve();
		await Promise.resolve();

		expect(aiJobsStore.queue[0]).toMatchObject({ markerId: "marker-1" });
	});

	it("limits SFX Pro queue starts to the account concurrency cap", () => {
		expect(aiJobsStore.maxConcurrent).toBe(2);
	});

	it("reruns an AI review marker as a fresh provider job and review marker", async () => {
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-rerun" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.spyOn(projectStore, "applyAiResult").mockResolvedValue(undefined);
		vi.mocked(api.rerunAiReviewMarker).mockResolvedValue({
			jobId: "job-rerun",
			prompt: "fresh rerun prompt",
			tier: "sfx-pro",
			reused: false,
			marker: { id: "marker-rerun" } as any,
			markers: [],
			activityLog: [],
		});
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		const accepted = await aiJobsStore.rerunAiReviewMarker(marker(), mockEditor);
		await Promise.resolve();
		await Promise.resolve();

		expect(accepted).toBe(true);
		expect(api.rerunAiReviewMarker).toHaveBeenCalledWith(
			"project-1",
			"marker-1",
			{
				lang: "th",
			},
			expect.stringMatching(/^ai-marker-rerun:project-1:marker-1:/),
			"sfx-pro",
		);
		expect(api.submitAiJob).not.toHaveBeenCalled();
		expect(projectStore.createAiReviewMarker).not.toHaveBeenCalled();
		expect(aiJobsStore.queue[0]).toMatchObject({
			id: expect.stringMatching(/^rerun-marker-1-/),
			status: "processing",
			stage: "processing",
			sourceMarkerId: "marker-1",
			markerId: "marker-rerun",
		});
		expect(projectStore.statusMsg).toBe("ส่งคำขอรัน AI หน้า 1 เข้าคิวแล้ว");
	});

	it("submits a cover job for the ACTIVE Language Track, not the default lang", async () => {
		// Multi-track project: default lang th, secondary en. After switching the active
		// track to en, the AI job must carry lang: "en" (PR-8 reads activeTargetLang).
		projectStore.__setProjectForTesting(project({ targetLang: "th", targetLangs: ["th", "en"] }));
		expect(projectStore.activeTargetLang).toBe("th");
		projectStore.setTargetLang("en");
		expect(projectStore.activeTargetLang).toBe("en");

		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		await aiJobsStore.generateCover(mockEditor);

		expect(api.submitAiJob).toHaveBeenCalledWith(expect.objectContaining({ lang: "en" }));
		expect(aiJobsStore.queue[0]).toMatchObject({ lang: "en" });
	});

	it("reruns a marker against the ACTIVE Language Track lang", async () => {
		projectStore.__setProjectForTesting(project({ targetLang: "th", targetLangs: ["th", "en"] }));
		projectStore.setTargetLang("en");

		const mockEditor = editor();
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-rerun" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.rerunAiReviewMarker).mockResolvedValue({
			jobId: "job-rerun",
			prompt: "fresh rerun prompt",
			tier: "sfx-pro",
			reused: false,
			marker: { id: "marker-rerun" } as any,
			markers: [],
			activityLog: [],
		});
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		const accepted = await aiJobsStore.rerunAiReviewMarker(marker(), mockEditor);

		expect(accepted).toBe(true);
		expect(api.rerunAiReviewMarker).toHaveBeenCalledWith(
			"project-1",
			"marker-1",
			{ lang: "en" },
			expect.stringMatching(/^ai-marker-rerun:project-1:marker-1:/),
			"sfx-pro",
		);
		expect(aiJobsStore.queue[0]).toMatchObject({ lang: "en" });
	});

	it("keeps a single-language project's AI job lang unaffected by setTargetLang", async () => {
		// Legacy single-track project: no targetLangs declared. setTargetLang is permissive
		// in-memory but the project has one track; a real submit still uses the project lang.
		projectStore.__setProjectForTesting(project({ targetLang: "th" }));
		// A stray switch to a non-track lang on a single-track project is permissive on the
		// alias, but back-compat consumers (cover jobs) still operate per the resolved alias.
		projectStore.setTargetLang("th");
		expect(projectStore.activeTargetLang).toBe("th");

		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		await aiJobsStore.generateCover(mockEditor);

		expect(api.submitAiJob).toHaveBeenCalledWith(expect.objectContaining({ lang: "th" }));
	});

	it("forwards the selected AI image quality to the submit call and the queued job", async () => {
		projectStore.__setProjectForTesting(project({ targetLang: "th" }));
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		aiJobsStore.setAiQuality("high");
		await aiJobsStore.generateCover(mockEditor);

		expect(api.submitAiJob).toHaveBeenCalledWith(expect.objectContaining({ quality: "high" }));
		expect(aiJobsStore.queue[0]).toMatchObject({ quality: "high" });
	});

	it("does not rerun a marker whose stored image no longer matches the page image", async () => {
		const accepted = await aiJobsStore.rerunAiReviewMarker(marker({ imageId: "old-image.webp" }), editor());

		expect(accepted).toBe(false);
		expect(api.submitAiJob).not.toHaveBeenCalled();
		expect(api.rerunAiReviewMarker).not.toHaveBeenCalled();
		expect(aiJobsStore.queue).toEqual([]);
		expect(projectStore.statusMsg).toBe("ผล AI นี้ผูกกับรูปเวอร์ชันเก่า; เปิดรูปหน้าที่ตรงกันหรือรันพื้นที่ใหม่อีกครั้ง");
	});

	it("keeps polling after a transient status error and sends the completed result to review", async () => {
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.spyOn(projectStore, "applyAiResult").mockResolvedValue(undefined);
		vi.mocked(api.submitAiJob).mockResolvedValue({
			jobId: "job-1",
			prompt: "prompt",
			tier: "sfx-pro",
		});
		vi.mocked(api.getAiStatus)
			.mockRejectedValueOnce(new Error("network jitter"))
			.mockResolvedValueOnce({ status: "done", resultImageId: "result_job-1.png" });

		await aiJobsStore.generateCover(mockEditor);
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);

		expect(aiJobsStore.queue[0]).toMatchObject({
			id: "job-1",
			status: "processing",
			stage: "processing",
		});
		expect(projectStore.statusMsg).toBe("เช็กสถานะ AI สะดุด กำลังลองใหม่ 1/3");
		expect(projectStore.applyAiResult).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);

		expect(projectStore.applyAiResult).not.toHaveBeenCalled();
		expect(projectStore.updateAiReviewMarker).toHaveBeenCalledWith("marker-1", expect.objectContaining({
			status: "needs_review",
			resultImageId: "result_job-1.png",
		}), { select: false });
		expect(projectStore.statusMsg).toBe("ผล AI พร้อมรีวิว หน้า 1 แล้ว");
		expect(aiJobsStore.queue).toEqual([]);
	});

	it("marks a completed job without a result image as failed instead of polling forever", async () => {
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.spyOn(projectStore, "applyAiResult").mockResolvedValue(undefined);
		vi.mocked(api.submitAiJob).mockResolvedValue({
			jobId: "job-1",
			prompt: "prompt",
			tier: "sfx-pro",
		});
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "done" });

		await aiJobsStore.generateCover(mockEditor);
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);

		expect(projectStore.applyAiResult).not.toHaveBeenCalled();
		expect(projectStore.updateAiReviewMarker).toHaveBeenCalledWith("marker-1", expect.objectContaining({
			status: "failed",
			error: "AI จบงานแล้วแต่ไม่มีรูปผลลัพธ์",
		}), { select: false });
		expect(mockEditor.updateProcessingIndicator).toHaveBeenCalledWith(
			expect.stringMatching(/^temp-/),
			"failed",
		);
		expect(projectStore.statusMsg).toBe("AI จบงานแล้วแต่ไม่มีรูปผลลัพธ์");
		expect(aiJobsStore.queue).toEqual([
			expect.objectContaining({
				id: "job-1",
				status: "error",
				stage: "failed",
				error: "AI จบงานแล้วแต่ไม่มีรูปผลลัพธ์",
			}),
		]);

		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs * 2);

		expect(api.getAiStatus).toHaveBeenCalledTimes(1);
	});

	it("cancels a running backend job instead of only clearing local polling", async () => {
		const mockEditor = editor();
		aiJobsStore.queue = [{
			id: "job-1",
			remoteJobId: "job-1",
			indicatorId: "temp-1",
			projectId: "project-1",
			imageId: "image-1.webp",
			crop: { x: 0, y: 0, w: 100, h: 100 },
			lang: "th",
			prompt: "prompt",
			thumbnail: "",
			status: "processing",
			stage: "processing",
			progress: 60,
			tier: "sfx-pro",
			pageIndex: 0,
			createdAt: Date.now(),
		}];
		vi.mocked(api.cancelAiJob).mockResolvedValue({
			ok: true,
			status: "cancelled",
			error: "Cancelled during processing",
			creditReservation: {
				status: "released",
				amountThb: 1,
				currency: "THB",
				createdAt: Date.now(),
				settledAt: Date.now(),
				reason: "job_cancelled",
			},
		});

		await aiJobsStore.cancelJob("job-1", mockEditor);

		expect(api.cancelAiJob).toHaveBeenCalledWith("job-1");
		expect(mockEditor.updateProcessingIndicator).toHaveBeenCalledWith("temp-1", "failed");
		expect(mockEditor.hideProcessingIndicator).toHaveBeenCalledWith("temp-1");
		expect(projectStore.statusMsg).toBe("AI ถูกยกเลิก: Cancelled during processing");
		expect(aiJobsStore.queue[0]).toMatchObject({
			id: "job-1",
			status: "cancelled",
			stage: "cancelled",
			error: "AI ถูกยกเลิก: Cancelled during processing",
			creditReservation: expect.objectContaining({ status: "released" }),
		});
	});

	it("shows backend cancellation returned by polling as a cancelled queue item", async () => {
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({
			jobId: "job-1",
			prompt: "prompt",
			tier: "sfx-pro",
		});
		vi.mocked(api.getAiStatus).mockResolvedValue({
			status: "cancelled",
			error: "Cancelled before processing",
		});

		await aiJobsStore.generateCover(mockEditor);
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);

		expect(aiJobsStore.queue[0]).toMatchObject({
			id: "job-1",
			status: "cancelled",
			stage: "cancelled",
			error: "AI ถูกยกเลิก: Cancelled before processing",
		});
		expect(projectStore.updateAiReviewMarker).toHaveBeenCalledWith("marker-1", expect.objectContaining({
			status: "failed",
			error: "AI ถูกยกเลิก: Cancelled before processing",
		}), { select: false });
		expect(projectStore.statusMsg).toBe("AI ถูกยกเลิก: Cancelled before processing");
	});

	it("never sends an explicit Idempotency-Key for single-gen (backend derives the authoritative key)", async () => {
		// ROOT-CAUSE FIX: the FE cannot know the backend's server-resolved BYO/platform
		// routing, so a FE-derived key could reuse the WRONG job or skip the platform
		// reservation path. Single-gen must omit the key and let the backend derive its
		// authoritative default (lang/tier/quality/prompt/BYO captured server-side).
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		await aiJobsStore.generateCover(mockEditor, "Clean the panel");

		expect(api.submitAiJob).toHaveBeenCalledTimes(1);
		const call = vi.mocked(api.submitAiJob).mock.calls[0][0];
		expect("idempotencyKey" in call ? call.idempotencyKey : undefined).toBeUndefined();
	});

	it("dedupes a rapid double-click on the SAME region to ONE backend submit (in-flight guard)", async () => {
		// Double-click = the second click fires while the first submit is still pending.
		// The client-side in-flight guard (keyed on region) blocks the second so only one
		// job is created and only one credit reservation is reserved — no double-charge.
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		// Submit never settles during the test window → both clicks overlap "in flight".
		let resolveSubmit: ((v: any) => void) | undefined;
		vi.mocked(api.submitAiJob).mockReturnValue(new Promise(res => { resolveSubmit = res; }) as any);
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		const first = aiJobsStore.generateCover(mockEditor, "Clean the panel");
		const second = aiJobsStore.generateCover(mockEditor, "Clean the panel");
		// Let the first submit's pre-submit awaits (saveState) flush so it reaches the
		// backend call; the second was dropped synchronously by the in-flight guard
		// before it ever got that far.
		await Promise.resolve();
		await Promise.resolve();
		// Only the first click reached the backend; the second was dropped by the guard.
		expect(api.submitAiJob).toHaveBeenCalledTimes(1);

		resolveSubmit?.({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		await Promise.all([first, second]);
		expect(api.submitAiJob).toHaveBeenCalledTimes(1);
	});

	it("allows a deliberate re-generate of the same region AFTER the first submit settles", async () => {
		// The guard is in-flight only: once the first submit settles it releases, so a
		// genuine re-generate is allowed. Reuse-correctness (identical inputs → one job)
		// is then the backend default key's responsibility, not the FE's.
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		await aiJobsStore.generateCover(mockEditor, "Clean the panel");
		await aiJobsStore.generateCover(mockEditor, "Clean the panel");

		// Two settled submits, neither carrying an FE key — the backend default key
		// dedupes identical resubmits server-side.
		expect(api.submitAiJob).toHaveBeenCalledTimes(2);
		for (const call of vi.mocked(api.submitAiJob).mock.calls) {
			expect("idempotencyKey" in call[0] ? call[0].idempotencyKey : undefined).toBeUndefined();
		}
	});

	it("creates a NEW job when the target LANGUAGE changes (backend default key, no FE key)", async () => {
		// Multi-track project so we can switch the active Language Track. A re-generate
		// after switching language must be a NEW job. With no FE key, the backend's own
		// default key (which folds in lang) guarantees that — and the request carries the
		// new lang.
		projectStore.__setProjectForTesting(project({ targetLang: "th", targetLangs: ["th", "en"] }));
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		await aiJobsStore.generateCover(mockEditor, "Clean the panel");
		projectStore.setTargetLang("en");
		await aiJobsStore.generateCover(mockEditor, "Clean the panel");

		expect(api.submitAiJob).toHaveBeenCalledTimes(2);
		expect(vi.mocked(api.submitAiJob).mock.calls[0][0].lang).toBe("th");
		expect(vi.mocked(api.submitAiJob).mock.calls[1][0].lang).toBe("en");
		// Neither call carries an FE-derived key.
		for (const call of vi.mocked(api.submitAiJob).mock.calls) {
			expect("idempotencyKey" in call[0] ? call[0].idempotencyKey : undefined).toBeUndefined();
		}
	});

	it("creates a NEW job when the SFX toggle changes (request carries the new translateSfx, no FE key)", async () => {
		// Toggling SFX must produce a NEW (SFX-translated vs not) result. With no FE key,
		// the backend default key (which folds in the prompt/SFX inputs) handles that; the
		// request itself carries the changed translateSfx.
		aiJobsStore.setAiTier("sfx-pro");
		const mockEditor = editor();
		mockEditor.getTextLayersInSelection.mockReturnValue(["SFX: boom"]);
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		aiJobsStore.sfxToggle = true;
		await aiJobsStore.generateCover(mockEditor, "Clean the panel");
		aiJobsStore.sfxToggle = false;
		await aiJobsStore.generateCover(mockEditor, "Clean the panel");

		expect(api.submitAiJob).toHaveBeenCalledTimes(2);
		expect(vi.mocked(api.submitAiJob).mock.calls[0][0].translateSfx).toBe(true);
		expect(vi.mocked(api.submitAiJob).mock.calls[1][0].translateSfx).toBe(false);
		for (const call of vi.mocked(api.submitAiJob).mock.calls) {
			expect("idempotencyKey" in call[0] ? call[0].idempotencyKey : undefined).toBeUndefined();
		}
	});

	it("routes clean tiers through the clean path without SFX text-layer plumbing", async () => {
		const mockEditor = editor();
		mockEditor.getTextLayersInSelection.mockReturnValue(["SFX: boom"]);
		aiJobsStore.setAiTier("budget-clean");
		aiJobsStore.setAiQuality("low");
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "budget-clean" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		await aiJobsStore.generateCover(mockEditor);

		// Clean tier: no SFX text layers gathered, no translateSfx flag.
		expect(mockEditor.getTextLayersInSelection).not.toHaveBeenCalled();
		const payload = vi.mocked(api.submitAiJob).mock.calls[0][0];
		expect(payload.tier).toBe("budget-clean");
		expect(payload.textLayers).toBeUndefined();
		expect(payload.translateSfx).toBe(false);
	});

	it("clearCompleted clears done/error/cancelled rows but keeps needs_review", () => {
		aiJobsStore.queue = [
			{ id: "a", status: "done" } as any,
			{ id: "b", status: "error" } as any,
			{ id: "c", status: "cancelled" } as any,
			{ id: "d", status: "needs_review" } as any,
			{ id: "e", status: "processing" } as any,
		];

		expect(aiJobsStore.clearableJobs.map((j) => j.id)).toEqual(["a", "b", "c"]);
		aiJobsStore.clearCompleted();
		expect(aiJobsStore.queue.map((j) => j.id)).toEqual(["d", "e"]);
	});
});

describe("AiJobsStore cross-project poll guard + teardown", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("project switch: a poll started under project A does NOT write A's result into project B", async () => {
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-A" } as any);
		const updateSpy = vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-A", prompt: "prompt", tier: "sfx-pro" });
		// The job stays processing on the first tick, then resolves AFTER we switch.
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "done", resultImageId: "result_job-A.png" });

		await aiJobsStore.generateCover(mockEditor);
		await Promise.resolve();
		// Marker created for A; nothing terminal yet.
		updateSpy.mockClear();
		mockEditor.hideProcessingIndicator.mockClear();
		mockEditor.updateProcessingIndicator.mockClear();

		// Switch to a DIFFERENT project (project-2) BEFORE the poll's next tick lands,
		// and seed B's status so we can prove A's completion never overwrites it.
		projectStore.__setProjectForTesting(project({ projectId: "project-2" }));
		projectStore.setStatusMsg("project-2 status");

		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);

		// The poll's resolution must NOT bleed into project B: no marker write, no
		// "ผล AI พร้อม" status overwrite, no indicator animation on B's canvas.
		expect(updateSpy).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe("project-2 status");
		expect(mockEditor.updateProcessingIndicator).not.toHaveBeenCalled();
		expect(mockEditor.hideProcessingIndicator).not.toHaveBeenCalled();

		// And the interval is gone — no further polling of A's job.
		const callsAfterSwitch = vi.mocked(api.getAiStatus).mock.calls.length;
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs * 3);
		expect(vi.mocked(api.getAiStatus).mock.calls.length).toBe(callsAfterSwitch);
	});

	it("same-project completion still applies the result (no false neutralization)", async () => {
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		const updateSpy = vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "done", resultImageId: "result_job-1.png" });

		await aiJobsStore.generateCover(mockEditor);
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);

		// No switch happened → the normal completion path runs in full.
		expect(updateSpy).toHaveBeenCalledWith("marker-1", expect.objectContaining({
			status: "needs_review",
			resultImageId: "result_job-1.png",
		}), { select: false });
		expect(projectStore.statusMsg).toBe("ผล AI พร้อมรีวิว หน้า 1 แล้ว");
		expect(aiJobsStore.queue).toEqual([]);
	});

	it("flushes a completed result that arrives before marker creation returns", async () => {
		vi.useFakeTimers();
		const mockEditor = editor();
		let resolveMarker!: (marker: any) => void;
		const markerPromise = new Promise<any>((resolve) => {
			resolveMarker = resolve;
		});
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockReturnValue(markerPromise);
		const updateSpy = vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "done", resultImageId: "result_job-1.png" });

		await aiJobsStore.generateCover(mockEditor);
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);

		expect(updateSpy).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe("ผล AI พร้อมรีวิว หน้า 1 แล้ว");

		resolveMarker({ id: "marker-1" });
		await Promise.resolve();
		await Promise.resolve();

		expect(updateSpy).toHaveBeenCalledWith("marker-1", expect.objectContaining({
			status: "needs_review",
			resultImageId: "result_job-1.png",
		}), { select: false });
	});

	it("reopening the SAME project keeps the in-flight poll valid (projectId match, not generation)", async () => {
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		const updateSpy = vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "done", resultImageId: "result_job-1.png" });

		await aiJobsStore.generateCover(mockEditor);
		await Promise.resolve();
		// Simulate a reopen of the SAME project (a new project-state object, same id).
		projectStore.__setProjectForTesting(project({ projectId: "project-1" }));

		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);

		// Same projectId → the completion still applies; the poll is NOT neutralized.
		expect(updateSpy).toHaveBeenCalledWith("marker-1", expect.objectContaining({
			status: "needs_review",
		}), { select: false });
	});

	it("sign-out mid getAiStatus-await + same-id reopen: the stale callback's post-await writes NOTHING (handle-generation guard) (round 8 FINDING 2)", async () => {
		// Round 8 FINDING 2: cleanup() can clearInterval the timer but CANNOT cancel a
		// callback already AWAITING getAiStatus. The per-tick projectId guard alone lets
		// the stale callback's post-await writes through when the user signs out and
		// reopens the SAME project id (projectId still matches). PollHandle.generation
		// pins the poll to the teardown generation it was armed under, and the post-await
		// guard checks teardownGeneration === handle.generation → a callback in flight
		// when cleanup() bumped the generation discards with no marker/status/queue write.
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		const updateSpy = vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });

		// First poll tick: hold getAiStatus OPEN so we can sign out + reopen WHILE the
		// callback is parked on the await (the gap the projectId guard cannot close).
		let resolveStatus!: (value: any) => void;
		vi.mocked(api.getAiStatus).mockReturnValue(
			new Promise((resolve) => { resolveStatus = resolve; }) as any,
		);

		await aiJobsStore.generateCover(mockEditor);
		await Promise.resolve();
		// Drive the interval so the tick fires and enters the (parked) getAiStatus await.
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);
		expect(vi.mocked(api.getAiStatus)).toHaveBeenCalledTimes(1);

		// Sign out (cleanup → generation bump) WHILE the callback is awaiting, then the
		// user signs back into the SAME project id — projectId match alone would PASS.
		// (cleanup() is the sign-out wipe; calling it directly mirrors the registered hook.)
		aiJobsStore.cleanup();
		projectStore.__setProjectForTesting(project({ projectId: "project-1" }));
		projectStore.setStatusMsg("fresh session status");
		updateSpy.mockClear();
		mockEditor.updateProcessingIndicator.mockClear();
		mockEditor.hideProcessingIndicator.mockClear();

		// The parked callback now resolves with a DONE result for the dead session's job.
		resolveStatus({ status: "done", resultImageId: "result_job-1.png" });
		await Promise.resolve();
		await Promise.resolve();

		// Generation mismatch → the stale callback writes NOTHING: no terminal marker
		// update, no status overwrite, no indicator animation, no phantom queue row.
		expect(updateSpy).not.toHaveBeenCalled();
		expect(projectStore.statusMsg).toBe("fresh session status");
		expect(mockEditor.updateProcessingIndicator).not.toHaveBeenCalled();
		expect(mockEditor.hideProcessingIndicator).not.toHaveBeenCalled();
		expect(aiJobsStore.queue).toEqual([]);
	});

	it("cancelPollsForProject stops the outgoing project's poll and drops its deferred marker update", async () => {
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		// Marker creation never resolves → the terminal update is DEFERRED into
		// pendingMarkerUpdates, keyed for project-1.
		vi.spyOn(projectStore, "createAiReviewMarker").mockReturnValue(new Promise(() => {}) as any);
		const updateSpy = vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "done", resultImageId: "result_job-1.png" });

		await aiJobsStore.generateCover(mockEditor);
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);
		// Job done but marker id unknown → update is deferred (not applied).
		expect(updateSpy).not.toHaveBeenCalled();

		const callsBefore = vi.mocked(api.getAiStatus).mock.calls.length;
		// The project-switch hook fires this with the OUTGOING projectId.
		aiJobsStore.cancelPollsForProject("project-1");

		// Now even if marker creation were to resolve, there's no deferred update left
		// to flush, and the poll interval is gone.
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs * 3);
		expect(vi.mocked(api.getAiStatus).mock.calls.length).toBe(callsBefore);
		expect(updateSpy).not.toHaveBeenCalled();
	});

	it("cancelPollsForProject DROPS the switched-away project's queue rows so they don't sit in activeJobs forever", async () => {
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-A", prompt: "prompt", tier: "sfx-pro" });
		// Stays processing forever → its row would be a permanent activeJobs zombie.
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		await aiJobsStore.generateCover(mockEditor);
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);

		// A processing row for project-1 exists with a live poller.
		expect(aiJobsStore.queue).toHaveLength(1);
		expect(aiJobsStore.activeJobs).toHaveLength(1);
		expect(aiJobsStore.queue[0]).toMatchObject({ projectId: "project-1", status: "processing" });

		// Project-switch hook fires with the OUTGOING projectId.
		aiJobsStore.cancelPollsForProject("project-1");

		// The orphaned processing row is gone — not left wedged in activeJobs where
		// clearCompleted (done/error/cancelled only) could never reach it.
		expect(aiJobsStore.queue).toEqual([]);
		expect(aiJobsStore.activeJobs).toEqual([]);
		// And nothing keeps polling the protected endpoint for the left project.
		const callsAfter = vi.mocked(api.getAiStatus).mock.calls.length;
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs * 3);
		expect(vi.mocked(api.getAiStatus).mock.calls.length).toBe(callsAfter);
	});

	it("cancelPollsForProject hides the CANVAS indicator of each dropped active row (round 7 FINDING 2)", async () => {
		// Round 7 FINDING 2: dropping the switched-away project's rows never cleared their
		// canvas indicators. The editor is REUSED across a switch (only destroy() tears it
		// down) and the indicator's RAF + rects are cleared ONLY by hideProcessingIndicator,
		// so the orphaned animations survived on the now-open project's canvas. The fix
		// best-effort hides each dropped row's indicator (via the poll handle's editor).
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-A", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		await aiJobsStore.generateCover(mockEditor);
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);
		const indicatorId = aiJobsStore.queue[0].indicatorId;
		expect(indicatorId).toMatch(/^temp-/);
		mockEditor.hideProcessingIndicator.mockClear();

		// Project-switch hook fires with the OUTGOING projectId.
		aiJobsStore.cancelPollsForProject("project-1");

		// The dropped row's canvas indicator was hidden on the (reused) editor.
		expect(mockEditor.hideProcessingIndicator).toHaveBeenCalledWith(indicatorId);
		expect(aiJobsStore.queue).toEqual([]);
	});

	it("cancelPollsForProject hides a SUSPENDED row's indicator via lastKnownEditor (no live handle)", async () => {
		// A row suspended (route-away) before the switch has NO poll handle — its handle was
		// cleared by suspendPolling. The indicator cleanup must still fire, using the store's
		// lastKnownEditor fallback (the editor we last saw at a poll/indicator entry point).
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-S", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		await aiJobsStore.generateCover(mockEditor);
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);
		const indicatorId = aiJobsStore.queue[0].indicatorId;

		// Route-away: clears the live poll handle but keeps the processing row.
		aiJobsStore.suspendPolling();
		mockEditor.hideProcessingIndicator.mockClear();

		// Now the project switches away while suspended → no handle for the row.
		aiJobsStore.cancelPollsForProject("project-1");

		// The fallback lastKnownEditor was used to hide the orphaned indicator.
		expect(mockEditor.hideProcessingIndicator).toHaveBeenCalledWith(indicatorId);
		expect(aiJobsStore.queue).toEqual([]);
	});

	it("cancelPollsForProject swallows a disposed editor's hide throw (cleanup must not break the switch)", async () => {
		// The editor may already be disposed (its Fabric canvas torn down) when the switch
		// runs, so hideProcessingIndicator can throw. The cleanup is best-effort: the throw
		// must be swallowed so the row is still dropped and the switch completes.
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-D", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		await aiJobsStore.generateCover(mockEditor);
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);
		const indicatorId = aiJobsStore.queue[0].indicatorId;
		// Editor disposed: hide throws.
		mockEditor.hideProcessingIndicator.mockImplementation(() => {
			throw new Error("Fabric canvas disposed");
		});

		// The throw is swallowed — the switch completes and the row is dropped.
		expect(() => aiJobsStore.cancelPollsForProject("project-1")).not.toThrow();
		expect(mockEditor.hideProcessingIndicator).toHaveBeenCalledWith(indicatorId);
		expect(aiJobsStore.queue).toEqual([]);
	});

	it("cancelPollsForProject only drops the LEFT project's rows, keeping another project's rows intact", () => {
		// Two projects' rows coexist in the single global queue (e.g. a left project's
		// terminal row plus the now-open project's rows). Clearing one project must not
		// touch the other's rows — and clearCompleted on the survivor still works.
		aiJobsStore.queue = [
			{ id: "a-proc", projectId: "project-1", status: "processing" } as any,
			{ id: "a-done", projectId: "project-1", status: "done" } as any,
			{ id: "b-proc", projectId: "project-2", status: "processing" } as any,
			{ id: "b-done", projectId: "project-2", status: "done" } as any,
		];

		aiJobsStore.cancelPollsForProject("project-1");

		// Only project-1's rows were dropped; project-2's survive untouched.
		expect(aiJobsStore.queue.map((j) => j.id)).toEqual(["b-proc", "b-done"]);
		// clearCompleted on the survivor is unblocked (b-done removable, b-proc stays).
		aiJobsStore.clearCompleted();
		expect(aiJobsStore.queue.map((j) => j.id)).toEqual(["b-proc"]);
	});

	it("a FAILED switch leaves A's polls running and A's queue rows intact (teardown not fired)", async () => {
		// P2: the teardown hook fires only AFTER openProject commits the switch. A switch
		// that fails at the save gate returns false and keeps A open — so A's live job
		// must keep polling AND its queue row must remain. We model the failed switch as
		// "the hook never fired" (cancelPollsForProject not called) and prove A's job is
		// still being driven to completion.
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		const updateSpy = vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus)
			.mockResolvedValueOnce({ status: "processing" })
			.mockResolvedValue({ status: "done", resultImageId: "result_job-1.png" });

		await aiJobsStore.generateCover(mockEditor);
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);

		// A's row is live and processing; the failed switch did NOT tear it down.
		expect(aiJobsStore.queue).toHaveLength(1);
		expect(aiJobsStore.queue[0]).toMatchObject({ projectId: "project-1", status: "processing" });

		// Project-1 is still the open project (the switch failed) → the next tick lands
		// the completion into project-1 normally, proving the poll stayed alive.
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);

		expect(updateSpy).toHaveBeenCalledWith("marker-1", expect.objectContaining({
			status: "needs_review",
			resultImageId: "result_job-1.png",
		}), { select: false });
		expect(projectStore.statusMsg).toBe("ผล AI พร้อมรีวิว หน้า 1 แล้ว");
		expect(aiJobsStore.queue).toEqual([]);
	});

	it("cleanup() (sign-out path) stops ALL polling and resets the concurrency count", async () => {
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		await aiJobsStore.generateCover(mockEditor);
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);
		const callsBefore = vi.mocked(api.getAiStatus).mock.calls.length;
		expect(callsBefore).toBeGreaterThan(0);

		aiJobsStore.cleanup();

		// No further status polls after sign-out cleanup — the protected endpoint is
		// no longer hit with a dead session.
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs * 5);
		expect(vi.mocked(api.getAiStatus).mock.calls.length).toBe(callsBefore);
	});

	it("submit for A resolving AFTER a switch to B writes A's marker (forProjectId) but no CLIENT mirror into B, and starts NO poll", async () => {
		// FINDING 1 (round 4): the job for A was ACCEPTED + CHARGED server-side. The
		// read-time reconciler only heals EXISTING processing markers, so dropping the
		// marker on discard would leave the finished job INVISIBLE when A reopens. The
		// discard path must therefore STILL create the marker — but against A's id via
		// { forProjectId } — while writing NO client mirror (queue/status/poll) into the
		// now-open B. projectStore.createAiReviewMarker's own post-await guard (verified
		// in its own test below) keeps B's local state clean.
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		const createSpy = vi
			.spyOn(projectStore, "createAiReviewMarker")
			.mockResolvedValue({ id: "marker-A" } as any);
		const updateSpy = vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);

		// Hold the submit open so we can switch to B BEFORE it resolves.
		let resolveSubmit!: (value: any) => void;
		vi.mocked(api.submitAiJob).mockReturnValue(
			new Promise((resolve) => {
				resolveSubmit = resolve;
			}) as any,
		);
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		// Kick off the submit under project A (do NOT await — it's blocked on submit).
		const generation = aiJobsStore.generateCover(mockEditor);
		// Flush PAST the pre-submit context gate (round 11 FINDING 2): the gate re-checks
		// the context right after the saveState await and before submit, so the switch this
		// test exercises (the POST-submit discard path) must land only once api.submitAiJob
		// is genuinely in flight — drain microtasks until the (blocked) submit is called.
		for (let i = 0; i < 6 && vi.mocked(api.submitAiJob).mock.calls.length === 0; i++) {
			await Promise.resolve();
		}
		expect(api.submitAiJob).toHaveBeenCalledTimes(1);
		// Project A's temp row is queued and uploading.
		expect(aiJobsStore.queue).toHaveLength(1);
		expect(aiJobsStore.queue[0]).toMatchObject({ projectId: "project-1", status: "pending" });

		// Switch to project B while the submit is still in flight.
		projectStore.__setProjectForTesting(project({ projectId: "project-2" }));
		projectStore.setStatusMsg("project-2 status");

		// Now the backend accepts A's job — but the active project is B.
		resolveSubmit({ jobId: "job-A", prompt: "prompt", tier: "sfx-pro" });
		await generation;
		await Promise.resolve();
		await Promise.resolve();

		// The marker IS created — but TARGETED at A (forProjectId), never B.
		expect(createSpy).toHaveBeenCalledTimes(1);
		expect(createSpy).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: "job-A" }),
			expect.objectContaining({ forProjectId: "project-1" }),
		);
		// No terminal marker write happened (the poll never ran for B)...
		expect(updateSpy).not.toHaveBeenCalled();
		// ...the A row is discarded (consistent with cancelPollsForProject's removal),
		// so B sees zero phantom jobs...
		expect(aiJobsStore.queue).toEqual([]);
		expect(aiJobsStore.activeJobs).toEqual([]);
		expect(aiJobsStore.queueStats.total).toBe(0);
		// ...B's status was never overwritten...
		expect(projectStore.statusMsg).toBe("project-2 status");
		// ...and NO poll was started (the protected endpoint is never hit for A).
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs * 4);
		expect(vi.mocked(api.getAiStatus)).not.toHaveBeenCalled();
	});

	it("same-project submit resolution still creates the marker and starts the poll", async () => {
		// Control for the discard test: with NO switch, the marker IS created under the
		// owning project and the poll runs to completion.
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		const createSpy = vi
			.spyOn(projectStore, "createAiReviewMarker")
			.mockResolvedValue({ id: "marker-1" } as any);
		const updateSpy = vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "done", resultImageId: "result_job-1.png" });

		await aiJobsStore.generateCover(mockEditor);
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);

		expect(createSpy).toHaveBeenCalled();
		expect(updateSpy).toHaveBeenCalledWith(
			"marker-1",
			expect.objectContaining({ status: "needs_review", resultImageId: "result_job-1.png" }),
			{ select: false },
		);
	});

	it("cleanup() empties the queue (sign-out leaves zero BatchPanel rows)", async () => {
		// FINDING 2 (round 3): cleanup() previously stopped timers + reset the count but
		// LEFT this.queue populated, so the NEXT signed-in user saw the prior session's
		// rows (prompts, thumbnails, project ids) in BatchPanel with no poller — a
		// privacy leak + permanent phantom active jobs. cleanup() must wipe the queue
		// and every BatchPanel-visible derived collection.
		aiJobsStore.queue = [
			{ id: "a", projectId: "project-1", status: "processing", prompt: "secret prompt A", thumbnail: "data:img/A" } as any,
			{ id: "b", projectId: "project-1", status: "done", prompt: "secret prompt B", thumbnail: "data:img/B" } as any,
			{ id: "c", projectId: "project-1", status: "needs_review", prompt: "secret prompt C" } as any,
		];

		expect(aiJobsStore.queue).toHaveLength(3);

		aiJobsStore.cleanup();

		// Every BatchPanel-visible getter is empty after sign-out.
		expect(aiJobsStore.queue).toEqual([]);
		expect(aiJobsStore.activeJobs).toEqual([]);
		expect(aiJobsStore.completedJobs).toEqual([]);
		expect(aiJobsStore.clearableJobs).toEqual([]);
		expect(aiJobsStore.queueStats).toMatchObject({ total: 0, pending: 0, processing: 0, done: 0, needsReview: 0 });
		// UI activity flags are reset too — no carried-over "generating" indication.
		expect(aiJobsStore.isGenerating).toBe(false);
		expect(aiJobsStore.aiStatus).toBe("");
	});

	it("cleanup() drops a live job's queue row AND stops its poller (no phantom active rows next session)", async () => {
		// End-to-end: a real in-flight job's row must be gone after cleanup, not just
		// its timer — the next signed-in user must inherit a fully empty queue.
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		await aiJobsStore.generateCover(mockEditor);
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);
		expect(aiJobsStore.queue).toHaveLength(1);
		expect(aiJobsStore.activeJobs).toHaveLength(1);

		aiJobsStore.cleanup();

		expect(aiJobsStore.queue).toEqual([]);
		expect(aiJobsStore.activeJobs).toEqual([]);
		const callsAfter = vi.mocked(api.getAiStatus).mock.calls.length;
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs * 5);
		expect(vi.mocked(api.getAiStatus).mock.calls.length).toBe(callsAfter);
	});

	it("a submit still in flight when cleanup() runs does NOT resurrect a poll/marker — even on same-id re-login (generation guard, FINDING 3)", async () => {
		// FINDING 3 (round 4): cleanup() (route-away / sign-out) cannot cancel a submit
		// still AWAITING api.submitAiJob — it has no PollHandle yet. The projectId guard
		// alone would let the continuation through if the user signs back into the SAME
		// project id (project-1), resurrecting a poll + marker on the disposed session. A
		// monotonic teardownGeneration captured before the submit, re-checked after,
		// makes the continuation a dead no-op.
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		const createSpy = vi
			.spyOn(projectStore, "createAiReviewMarker")
			.mockResolvedValue({ id: "marker-1" } as any);
		const updateSpy = vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);

		// Hold the submit open so we can cleanup() BEFORE it resolves.
		let resolveSubmit!: (value: any) => void;
		vi.mocked(api.submitAiJob).mockReturnValue(
			new Promise((resolve) => {
				resolveSubmit = resolve;
			}) as any,
		);
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		// Kick off the submit under project-1 (do NOT await — it's blocked on submit).
		const generation = aiJobsStore.generateCover(mockEditor);
		await Promise.resolve();
		expect(aiJobsStore.queue).toHaveLength(1);

		// Sign out (cleanup) while the submit is still in flight — bumps the generation.
		aiJobsStore.cleanup();
		expect(aiJobsStore.queue).toEqual([]);

		// User signs back into the SAME project id (project-1) — the projectId guard
		// alone would PASS here, so only the generation guard can stop the continuation.
		projectStore.__setProjectForTesting(project({ projectId: "project-1" }));
		projectStore.setStatusMsg("fresh session status");

		// The backend now accepts the OLD job — the continuation must be dead.
		resolveSubmit({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		await generation;
		await Promise.resolve();
		await Promise.resolve();

		// No marker written (no API write resurrecting the disposed job)...
		expect(createSpy).not.toHaveBeenCalled();
		expect(updateSpy).not.toHaveBeenCalled();
		// ...the fresh session's queue stays empty (no phantom row)...
		expect(aiJobsStore.queue).toEqual([]);
		expect(aiJobsStore.activeJobs).toEqual([]);
		// ...the fresh session's status is untouched...
		expect(projectStore.statusMsg).toBe("fresh session status");
		// ...and NO poll was started on the disposed session.
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs * 4);
		expect(vi.mocked(api.getAiStatus)).not.toHaveBeenCalled();
	});

	it("sign-out mid createAiReviewMarker-await + same-id reopen: server write made, but isContextCurrent gates OUT the local apply (round 8 FINDING 1)", async () => {
		// Round 8 FINDING 1: the submit already resolved (passed the inline generation
		// guard), so createMarkerForRunningJob runs and reaches the createAiReviewMarker
		// API await. Sign-out THEN happens while that round-trip is in flight. The id-only
		// apply guard inside createAiReviewMarker is too weak: cleanup() wipes THIS store
		// but the project store may still hold project-1's id, so the id match alone would
		// let the dead session's marker/activity apply locally; the CALLER's generation
		// check only runs AFTER createAiReviewMarker returns — too late. The fix threads an
		// isContextCurrent callback (our captured-generation check) into createAiReviewMarker
		// so the local apply is skipped, while the SERVER write still happens (job charged).
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		// Hold the marker create OPEN so we can sign out WHILE its round-trip is in flight,
		// AFTER the submit already resolved (so the marker create path is actually reached).
		let resolveMarker!: (value: any) => void;
		let capturedOptions: any;
		const createSpy = vi
			.spyOn(projectStore, "createAiReviewMarker")
			.mockImplementation((_input, options) => {
				capturedOptions = options;
				return new Promise((resolve) => { resolveMarker = resolve; }) as any;
			});

		// createMarkerForRunningJob is fire-and-forget (void) inside generateCover, but it
		// invokes createAiReviewMarker synchronously before its first await, so awaiting the
		// generateCover promise (the marker create is held open) is enough to reach it.
		await aiJobsStore.generateCover(mockEditor);
		// The marker create round-trip is now in flight, targeting the owner.
		expect(createSpy).toHaveBeenCalledTimes(1);
		expect(capturedOptions).toMatchObject({ forProjectId: "project-1" });
		// The captured-generation gate reports CURRENT before sign-out.
		expect(capturedOptions.isContextCurrent()).toBe(true);

		// Sign out (cleanup → generation bump) WHILE the marker create is awaiting, then the
		// user signs back into the SAME project id — this.project.projectId again matches
		// the owner, so the id-only gate inside createAiReviewMarker would PASS on its own.
		// (cleanup() is the sign-out wipe; calling it directly mirrors the registered hook.)
		aiJobsStore.cleanup();
		projectStore.__setProjectForTesting(project({ projectId: "project-1" }));

		// The threaded callback now reports the context is DEAD (generation mismatch), which
		// is exactly what createAiReviewMarker consults to skip the local apply.
		expect(capturedOptions.isContextCurrent()).toBe(false);

		// Resolve the server write (it still happened — job accepted+charged, reloadable).
		resolveMarker({ id: "marker-1" });
		await Promise.resolve();
		await Promise.resolve();

		// The SERVER write was issued for the owner...
		expect(createSpy).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: "job-1" }),
			expect.objectContaining({ forProjectId: "project-1" }),
		);
		// ...but the dead session left no phantom row in the fresh queue.
		expect(aiJobsStore.queue).toEqual([]);
	});
});

describe("AiJobsStore route-away suspend/resume (FINDING 1) + batch mid-switch re-check (FINDING 2)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("route-away (suspendPolling): an in-flight submit still WRITES the server marker and starts NO interval", async () => {
		// FINDING 1: WorkspaceShell.onDestroy fires on a plain route-away (e.g. /settings)
		// for the STILL-open project. The narrow suspendPolling tier must NOT bump the
		// generation, so a submit accepted+charged mid-route-away still creates its server
		// marker (forProjectId) — but it must NOT arm a poll interval while suspended.
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		const createSpy = vi
			.spyOn(projectStore, "createAiReviewMarker")
			.mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);

		// Hold the submit open so we can suspend BEFORE it resolves.
		let resolveSubmit!: (value: any) => void;
		vi.mocked(api.submitAiJob).mockReturnValue(
			new Promise((resolve) => { resolveSubmit = resolve; }) as any,
		);
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		const generation = aiJobsStore.generateCover(mockEditor);
		await Promise.resolve();
		expect(aiJobsStore.queue).toHaveLength(1);

		// Route away to /settings → WorkspaceShell.onDestroy → suspendPolling (NOT cleanup).
		aiJobsStore.suspendPolling();
		// The queue row survives the route-away (NOT a sign-out wipe).
		expect(aiJobsStore.queue).toHaveLength(1);

		// Backend accepts the still-owned project's job while suspended.
		resolveSubmit({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		await generation;
		await Promise.resolve();
		await Promise.resolve();

		// The server marker IS written for the owner (job accepted+charged, must be
		// reloadable) — the bug this fixes was the old cleanup() path SKIPPING it.
		expect(createSpy).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: "job-1" }),
			expect.objectContaining({ forProjectId: "project-1" }),
		);
		// The row remains processing in the queue...
		expect(aiJobsStore.queue[0]).toMatchObject({ id: "job-1", status: "processing" });
		// ...but NO poll interval was armed while suspended.
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs * 4);
		expect(vi.mocked(api.getAiStatus)).not.toHaveBeenCalled();
	});

	it("poll callback awaiting getAiStatus across a suspend writes NOTHING + touches NO editor (round 9 FINDING 1: suspendGeneration guard)", async () => {
		// Round 9 FINDING 1: suspendPolling() clearIntervals the timer but CANNOT cancel a
		// callback already AWAITING getAiStatus. A route-away bumps NEITHER the projectId nor
		// the teardown generation, so without a separate guard the parked callback would pass
		// isPollContextCurrent on resolution and run its terminal branch — touching the now-
		// DISPOSED Fabric editor. The PollHandle.suspendGeneration pin (captured at arm time,
		// bumped by suspendPolling, re-checked post-await) makes that callback a dead no-op.
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		const updateSpy = vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });

		// First poll tick: hold getAiStatus OPEN so we can route away WHILE the callback is
		// parked on the await (the gap suspendPolling's clearInterval cannot close).
		let resolveStatus!: (value: any) => void;
		vi.mocked(api.getAiStatus).mockReturnValue(
			new Promise((resolve) => { resolveStatus = resolve; }) as any,
		);

		await aiJobsStore.generateCover(mockEditor);
		await Promise.resolve();
		// Drive the interval so the tick fires and enters the (parked) getAiStatus await.
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);
		expect(vi.mocked(api.getAiStatus)).toHaveBeenCalledTimes(1);

		// Route away (WorkspaceShell.onDestroy → suspendPolling) WHILE the callback awaits —
		// the editor is now disposed. projectId + teardownGeneration are UNCHANGED, so only
		// suspendGeneration can neutralize the parked callback.
		aiJobsStore.suspendPolling();
		updateSpy.mockClear();
		mockEditor.updateProcessingIndicator.mockClear();
		mockEditor.hideProcessingIndicator.mockClear();

		// The parked callback now resolves with a DONE result for the routed-away job.
		resolveStatus({ status: "done", resultImageId: "result_job-1.png" });
		await Promise.resolve();
		await Promise.resolve();

		// suspendGeneration mismatch → the stale callback writes NOTHING: no terminal marker
		// update, no indicator/hide call on the disposed editor. The row stays processing for
		// resumePolling to re-arm on the next mount (not torn down — a route-away keeps it).
		expect(updateSpy).not.toHaveBeenCalled();
		expect(mockEditor.updateProcessingIndicator).not.toHaveBeenCalled();
		expect(mockEditor.hideProcessingIndicator).not.toHaveBeenCalled();
		expect(aiJobsStore.queue[0]).toMatchObject({ id: "job-1", status: "processing" });
	});

	it("submit resolving AFTER suspend with a DISPOSED (throwing) editor still creates the marker + throws nothing (round 9 FINDING 2)", async () => {
		// Round 9 FINDING 2: when a submit resolves AFTER suspendPolling(), the continuation
		// must run createMarkerForRunningJob (the accepted+charged job's only record on reopen)
		// BEFORE any editor indicator mutation. The disposed editor's updateProcessingIndicator
		// THROWS; the OLD ordering let that throw land in the catch BEFORE the marker write, so
		// the charged job was left WITHOUT its server marker. The fix orders the marker first
		// and makes the indicator best-effort, so a disposed canvas can never abort it.
		vi.useFakeTimers();
		const mockEditor = editor();
		// Editor disposed by the route-away: every indicator call throws.
		const disposed = new Error("Fabric canvas disposed");
		mockEditor.updateProcessingIndicator.mockImplementation(() => { throw disposed; });
		mockEditor.hideProcessingIndicator.mockImplementation(() => { throw disposed; });
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		const createSpy = vi
			.spyOn(projectStore, "createAiReviewMarker")
			.mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);

		// Hold the submit open so we can suspend (disposing the editor) BEFORE it resolves.
		let resolveSubmit!: (value: any) => void;
		vi.mocked(api.submitAiJob).mockReturnValue(
			new Promise((resolve) => { resolveSubmit = resolve; }) as any,
		);
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		const generation = aiJobsStore.generateCover(mockEditor);
		await Promise.resolve();
		expect(aiJobsStore.queue).toHaveLength(1);

		// Route away to /settings → suspendPolling (NOT cleanup) → editor disposed.
		aiJobsStore.suspendPolling();

		// Backend accepts the still-owned project's job while suspended + editor disposed.
		resolveSubmit({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		await generation;
		await Promise.resolve();
		await Promise.resolve();

		// The server marker IS written for the owner despite the throwing editor — the charged
		// job stays recoverable on reopen (the bug left it markerless).
		expect(createSpy).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: "job-1" }),
			expect.objectContaining({ forProjectId: "project-1" }),
		);
		// The row stays processing-without-interval (resumePolling re-arms it on remount)...
		expect(aiJobsStore.queue[0]).toMatchObject({ id: "job-1", status: "processing" });
		// ...and NO poll interval was armed while suspended (no getAiStatus hits).
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs * 4);
		expect(vi.mocked(api.getAiStatus)).not.toHaveBeenCalled();
	});

	it("resumePolling re-arms a poll for a suspended processing row and completion applies", async () => {
		// On the next shell mount, resumePolling clears the flag and re-arms a poll for the
		// open project's still-processing rows; the re-armed poll drives the job to a result.
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		const updateSpy = vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "done", resultImageId: "result_job-1.png" });

		await aiJobsStore.generateCover(mockEditor);
		// A live poll exists for job-1; route away suspends it.
		aiJobsStore.suspendPolling();
		const callsAfterSuspend = vi.mocked(api.getAiStatus).mock.calls.length;
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs * 3);
		// Suspended → no polling at all.
		expect(vi.mocked(api.getAiStatus).mock.calls.length).toBe(callsAfterSuspend);
		expect(aiJobsStore.queue[0]).toMatchObject({ id: "job-1", status: "processing" });

		// Next shell mount → resumePolling re-arms the poll with the fresh editor.
		const freshEditor = editor();
		aiJobsStore.resumePolling(freshEditor);
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);

		// The re-armed poll lands the completion: the terminal marker write happens and the
		// row reaches a terminal state (the generic re-arm helper keeps it as a `done`
		// completed row rather than removing it — both are out of activeJobs, the goal).
		expect(updateSpy).toHaveBeenCalledWith("marker-1", expect.objectContaining({
			status: "needs_review",
			resultImageId: "result_job-1.png",
		}), { select: false });
		expect(aiJobsStore.queue[0]).toMatchObject({ id: "job-1", status: "done" });
		expect(aiJobsStore.activeJobs).toEqual([]);
	});

	it("resumePolling only re-arms the CURRENTLY OPEN project's rows; other-project rows stay dormant", async () => {
		// After a route-away, the queue can still hold rows for the project that was open.
		// resumePolling must re-arm ONLY the now-open project's rows; a stray row for a
		// different project (e.g. one that survived in the global queue) must NOT be polled.
		vi.useFakeTimers();
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });
		// Two processing rows: one for the open project-1, one for a foreign project-2.
		aiJobsStore.queue = [
			{ id: "open-job", projectId: "project-1", status: "processing", remoteJobId: "open-job", pageIndex: 0 } as any,
			{ id: "foreign-job", projectId: "project-2", status: "processing", remoteJobId: "foreign-job", pageIndex: 0 } as any,
		];
		// Mark suspended so resumePolling is the path under test.
		aiJobsStore.suspendPolling();

		aiJobsStore.resumePolling(editor());
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);

		// Only the open project's job was polled; the foreign row stayed dormant.
		const polled = vi.mocked(api.getAiStatus).mock.calls.map((c) => c[0]);
		expect(polled).toContain("open-job");
		expect(polled).not.toContain("foreign-job");
	});

	it("sign-out (cleanup) still SKIPS the marker and CLEARS the queue (unchanged full-teardown tier)", async () => {
		// The full tier is reserved for sign-out: it bumps the generation (so an in-flight
		// submit's continuation is a dead no-op, NO marker) and wipes the queue. This is the
		// contrast to the route-away tier above.
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		const createSpy = vi
			.spyOn(projectStore, "createAiReviewMarker")
			.mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);

		let resolveSubmit!: (value: any) => void;
		vi.mocked(api.submitAiJob).mockReturnValue(
			new Promise((resolve) => { resolveSubmit = resolve; }) as any,
		);
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		const generation = aiJobsStore.generateCover(mockEditor);
		await Promise.resolve();
		expect(aiJobsStore.queue).toHaveLength(1);

		// Sign-out (registerPreSignOut) → cleanup(): bumps generation + clears queue.
		aiJobsStore.cleanup();
		expect(aiJobsStore.queue).toEqual([]);

		resolveSubmit({ jobId: "job-1", prompt: "prompt", tier: "sfx-pro" });
		await generation;
		await Promise.resolve();
		await Promise.resolve();

		// No marker written (generation bumped → continuation is a dead no-op).
		expect(createSpy).not.toHaveBeenCalled();
		expect(aiJobsStore.queue).toEqual([]);
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs * 4);
		expect(vi.mocked(api.getAiStatus)).not.toHaveBeenCalled();
	});

	it("batch loop mid-switch (FINDING 2): a removed job is NEVER submitted (no credit charge for invisible work)", async () => {
		// Two batch jobs queued for project-1. startBatchJob awaits the FIRST submit; a
		// project switch DURING that await drops both A rows (cancelPollsForProject). The
		// loop must re-check before the SECOND startBatchJob and skip the removed job, so
		// api.submitAiJob is called exactly ONCE — never for the second (removed) job.
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);

		// Hold the FIRST submit open so the switch lands mid-loop, between job 1 and job 2.
		let resolveFirst!: (value: any) => void;
		vi.mocked(api.submitAiJob).mockImplementationOnce(
			() => new Promise((resolve) => { resolveFirst = resolve; }) as any,
		).mockResolvedValue({ jobId: "job-2", prompt: "p", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		// Two crops → two pending batch rows (maxConcurrent is 2, so both are picked up).
		void aiJobsStore.addBatchJobs(mockEditor, [
			{ x: 0, y: 0, w: 100, h: 100 },
			{ x: 200, y: 0, w: 100, h: 100 },
		]);
		for (let i = 0; i < 4; i++) await Promise.resolve();

		// Job 1's submit is in flight (blocked); only it has reached the backend so far.
		expect(api.submitAiJob).toHaveBeenCalledTimes(1);

		// Switch away mid-loop: the project-switch hook drops project-1's queue rows.
		aiJobsStore.cancelPollsForProject("project-1");
		projectStore.__setProjectForTesting(project({ projectId: "project-2" }));

		// Resolve job 1's submit; the loop now advances to job 2 — which was REMOVED.
		resolveFirst({ jobId: "job-1", prompt: "p", tier: "sfx-pro" });
		for (let i = 0; i < 8; i++) await Promise.resolve();

		// The re-check skipped the removed second job → still exactly ONE submit, no
		// credit charge for the invisible (dropped) row.
		expect(api.submitAiJob).toHaveBeenCalledTimes(1);
	});

	it("generateCover mid saveState-await switch: NEVER submits (no charge) and drops the temp row (round 11 FINDING 2)", async () => {
		// Round 11 FINDING 2: generateCover's context guard runs AFTER api.submitAiJob — so a
		// project switch (or sign-out) DURING the preceding projectStore.saveState() await still
		// SUBMITS (and CHARGES) a job whose temp row was already removed by the switch's
		// cancelPollsForProject. The fix mirrors the batch path: re-check isSubmitContextCurrent
		// immediately after the saveState await and BEFORE submit. On mismatch: drop the temp
		// row (if present), hide the indicator best-effort, and return WITHOUT submitting.
		const mockEditor = editor();
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);

		// Hold saveState open so the switch lands BETWEEN saveState and submitAiJob.
		let resolveSave!: () => void;
		vi.spyOn(projectStore, "saveState").mockReturnValue(
			new Promise<void>((resolve) => { resolveSave = resolve; }),
		);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "p", tier: "sfx-pro" });

		const gen = aiJobsStore.generateCover(mockEditor, "Clean the panel");
		// Flush up to the (now-blocked) saveState await: the temp row is in the queue.
		for (let i = 0; i < 4; i++) await Promise.resolve();
		expect(aiJobsStore.activeJobs).toHaveLength(1);
		expect(api.submitAiJob).not.toHaveBeenCalled();

		// Switch away mid-await: the project-switch hook drops project-1's queue rows (incl.
		// the temp single-gen row) and the open project is now a DIFFERENT id.
		aiJobsStore.cancelPollsForProject("project-1");
		projectStore.__setProjectForTesting(project({ projectId: "project-2" }));

		// Resolve saveState → generateCover continues. The pre-submit gate must catch the
		// switch and bail BEFORE the charging submit.
		resolveSave();
		await gen;
		for (let i = 0; i < 4; i++) await Promise.resolve();

		// The (charging) submit was NEVER called for the switched-away job.
		expect(api.submitAiJob).not.toHaveBeenCalled();
		// The temp row is gone (cancelPollsForProject removed it; the gate is a no-op on it).
		expect(aiJobsStore.activeJobs).toHaveLength(0);
		expect(aiJobsStore.queueStats.total).toBe(0);
		// Best-effort indicator hide ran for the dropped temp row.
		expect(mockEditor.hideProcessingIndicator).toHaveBeenCalled();
	});

	it("generateCover with NO switch still submits (pre-submit gate is not over-eager) (round 11 FINDING 2 control)", async () => {
		// Control for the pre-submit gate: with the owning project still open + no teardown,
		// the gate passes and the single submit fires — the re-check must not drop a
		// legitimately-current generation.
		const mockEditor = editor();
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "p", tier: "sfx-pro" });

		await aiJobsStore.generateCover(mockEditor, "Clean the panel");
		for (let i = 0; i < 4; i++) await Promise.resolve();

		expect(api.submitAiJob).toHaveBeenCalledTimes(1);
	});

	it("batch loop with NO switch still submits every queued job (re-check is not over-eager)", async () => {
		// Control for FINDING 2: with no switch, both rows are still queued + context-current,
		// so both submits fire — the re-check must not drop legitimately-pending work.
		const mockEditor = editor();
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob)
			.mockResolvedValueOnce({ jobId: "job-1", prompt: "p", tier: "sfx-pro" })
			.mockResolvedValueOnce({ jobId: "job-2", prompt: "p", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		await aiJobsStore.addBatchJobs(mockEditor, [
			{ x: 0, y: 0, w: 100, h: 100 },
			{ x: 200, y: 0, w: 100, h: 100 },
		]);
		// addBatchJobs fires processNextBatchJobs without awaiting it; flush the loop's
		// two sequential awaited submits (real timers, so microtasks drain naturally).
		for (let i = 0; i < 8; i++) await Promise.resolve();

		expect(api.submitAiJob).toHaveBeenCalledTimes(2);
	});
});

describe("AiJobsStore round-6 slot accounting + permanent sign-out hook", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("FINDING 1: signing out AFTER a route-away still wipes the queue (hook is store-level, not shell-scoped)", async () => {
		// The pre-sign-out hook is registered ONCE at the store level (root +layout calls
		// registerSignOutCleanup) — NOT in WorkspaceShell.onMount/onDestroy. So routing away
		// (suspendPolling) does NOT remove it, and a sign-out from /settings still runs
		// cleanup(), leaving the next user a clean queue. Previously the shell unregistered
		// the hook on unmount, so a /settings sign-out skipped the wipe (privacy leak).
		await aiJobsStore.registerSignOutCleanup();
		// Idempotent: a second call must not register a duplicate hook.
		await aiJobsStore.registerSignOutCleanup();
		expect(preSignOutHooks).toHaveLength(1);

		// Seed a session's queue (prompts/thumbnails the next user must never see).
		aiJobsStore.queue = [
			{ id: "a", projectId: "project-1", status: "processing", prompt: "secret A", thumbnail: "data:img/A" } as any,
			{ id: "b", projectId: "project-1", status: "needs_review", prompt: "secret B" } as any,
		];

		// Route away to /settings → WorkspaceShell.onDestroy → suspendPolling (NOT cleanup).
		// The hook must survive this unmount.
		aiJobsStore.suspendPolling();
		expect(preSignOutHooks).toHaveLength(1);
		// The queue is NOT wiped by a route-away.
		expect(aiJobsStore.queue).toHaveLength(2);

		// Now sign out FROM /settings (the shell is unmounted). The store-level hook fires.
		await runSignOutHooks();

		// The previous session's rows are gone — the next signed-in user inherits nothing.
		expect(aiJobsStore.queue).toEqual([]);
		expect(aiJobsStore.activeJobs).toEqual([]);
	});

	it("FINDING 2: suspend → switch frees ALL the left project's slots (a new batch in project B runs)", async () => {
		// A route-away clears poll handles while the batch rows stay processing. A direct
		// nav to another project then drops those rows via cancelPollsForProject — which must
		// reconcile processingCount off the REMOVED ROWS, not the (now absent) handles. If it
		// counted handles it would free nothing and wedge the count at maxConcurrent forever,
		// so project B's new batch would never get a slot.
		const mockEditor = editor();
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob)
			.mockResolvedValueOnce({ jobId: "job-A1", prompt: "p", tier: "sfx-pro" })
			.mockResolvedValueOnce({ jobId: "job-A2", prompt: "p", tier: "sfx-pro" })
			.mockResolvedValue({ jobId: "job-B1", prompt: "p", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });

		// Fill BOTH slots in project A (maxConcurrent === 2).
		await aiJobsStore.addBatchJobs(mockEditor, [
			{ x: 0, y: 0, w: 100, h: 100 },
			{ x: 200, y: 0, w: 100, h: 100 },
		]);
		for (let i = 0; i < 8; i++) await Promise.resolve();
		expect(api.submitAiJob).toHaveBeenCalledTimes(2);
		// Both slots are taken; two rows hold a slot.
		aiJobsStore.__assertSlotInvariant();
		expect(aiJobsStore.queue.filter((j) => j.holdsBatchSlot).length).toBe(2);

		// Route away (clears handles, rows stay processing) THEN nav to project B.
		aiJobsStore.suspendPolling();
		aiJobsStore.cancelPollsForProject("project-1");
		projectStore.__setProjectForTesting(project({ projectId: "project-2" }));

		// Every slot the left project held was freed off its rows — invariant holds at zero.
		aiJobsStore.__assertSlotInvariant();
		expect(aiJobsStore.queue).toEqual([]);

		// Project B can now run a fresh batch (a slot is actually available).
		const editorB = editor();
		await aiJobsStore.addBatchJobs(editorB, [{ x: 0, y: 0, w: 100, h: 100 }]);
		for (let i = 0; i < 8; i++) await Promise.resolve();

		expect(api.submitAiJob).toHaveBeenCalledTimes(3);
		expect(api.submitAiJob).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: "project-2" }));
		aiJobsStore.__assertSlotInvariant();
	});

	it("FINDING 3: resuming a single-gen row to completion never drives the count negative; a later batch still respects maxConcurrent", async () => {
		// A single-generate row (generateCover) never takes a batch slot. resumePolling
		// re-arms EVERY running row through pollBatchJob, whose terminal branch decrements —
		// but only via releaseBatchSlot, which is a no-op for the slot-less single-gen row.
		// So the count cannot go negative, and a later batch still sees the true free slots.
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		const updateSpy = vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "single-1", prompt: "p", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "done", resultImageId: "result_single-1.png" });

		// Single-gen submit creates a processing row that holds NO slot.
		await aiJobsStore.generateCover(mockEditor);
		expect(aiJobsStore.queue[0]).toMatchObject({ id: "single-1", status: "processing" });
		expect(aiJobsStore.queue[0].holdsBatchSlot).toBeFalsy();
		aiJobsStore.__assertSlotInvariant();

		// Route away then back: suspend, then resumePolling re-arms the single-gen row
		// through pollBatchJob with a fresh editor.
		aiJobsStore.suspendPolling();
		const freshEditor = editor();
		aiJobsStore.resumePolling(freshEditor);
		await vi.advanceTimersByTimeAsync(config.aiPollIntervalMs);

		// The re-armed poll lands the completion (terminal decrement ran) — but the count
		// did NOT go negative because the single-gen row held no slot.
		expect(updateSpy).toHaveBeenCalledWith("marker-1", expect.objectContaining({
			status: "needs_review",
			resultImageId: "result_single-1.png",
		}), { select: false });
		aiJobsStore.__assertSlotInvariant();

		// A later batch still respects maxConcurrent: queue 3 jobs, only 2 (the cap) submit.
		const batchEditor = editor();
		vi.mocked(api.submitAiJob)
			.mockResolvedValueOnce({ jobId: "batch-1", prompt: "p", tier: "sfx-pro" })
			.mockResolvedValueOnce({ jobId: "batch-2", prompt: "p", tier: "sfx-pro" })
			.mockResolvedValue({ jobId: "batch-3", prompt: "p", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" });
		const submitsBefore = vi.mocked(api.submitAiJob).mock.calls.length;

		await aiJobsStore.addBatchJobs(batchEditor, [
			{ x: 0, y: 0, w: 100, h: 100 },
			{ x: 200, y: 0, w: 100, h: 100 },
			{ x: 400, y: 0, w: 100, h: 100 },
		]);
		for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);

		// Exactly maxConcurrent (2) new submits fired — the third waits for a free slot.
		expect(vi.mocked(api.submitAiJob).mock.calls.length - submitsBefore).toBe(2);
		aiJobsStore.__assertSlotInvariant();
		expect(aiJobsStore.queue.filter((j) => j.holdsBatchSlot).length).toBe(2);
	});
});

describe("catch-entry context guards (round 12)", () => {
	it("a poll REJECTION landing after sign-out writes no retry/error state", async () => {
		const mockEditor = editor();
		let rejectStatus: ((e: Error) => void) | undefined;
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "remote-catch-1", costEstimate: undefined, creditReservation: undefined } as never);
		vi.mocked(api.getAiStatus).mockImplementation(
			() => new Promise((_, reject) => { rejectStatus = reject; }),
		);
		vi.useFakeTimers();
		await aiJobsStore.addBatchJobs(mockEditor, [{ x: 0, y: 0, w: 100, h: 100 }]);
		for (let i = 0; i < 8; i++) await Promise.resolve();
		await vi.advanceTimersByTimeAsync(2500);
		expect(rejectStatus).toBeDefined();

		aiJobsStore.cleanup(); // sign-out mid getAiStatus-await
		const statusBefore = projectStore.statusMsg;
		rejectStatus!(new Error("network down"));
		for (let i = 0; i < 8; i++) await Promise.resolve();

		// The catch-entry guard discards the stale rejection: no retry status
		// written into the post-sign-out store, queue stays wiped.
		expect(projectStore.statusMsg).toBe(statusBefore);
		expect(aiJobsStore.queue).toEqual([]);
	});

	it("a submit REJECTION landing after sign-out writes no status into the next session", async () => {
		const mockEditor = editor();
		let rejectSubmit: ((e: Error) => void) | undefined;
		vi.mocked(api.submitAiJob).mockImplementation(
			() => new Promise((_, reject) => { rejectSubmit = reject; }),
		);
		await aiJobsStore.addBatchJobs(mockEditor, [{ x: 0, y: 0, w: 100, h: 100 }]);
		for (let i = 0; i < 8; i++) await Promise.resolve();
		expect(rejectSubmit).toBeDefined();

		aiJobsStore.cleanup(); // sign-out while the submit is in flight
		const statusBefore = projectStore.statusMsg;
		rejectSubmit!(new Error("provider 500"));
		for (let i = 0; i < 8; i++) await Promise.resolve();

		// discardSwitchedAwayJob at catch entry: no status overwrite, no row revived.
		expect(projectStore.statusMsg).toBe(statusBefore);
		expect(aiJobsStore.queue).toEqual([]);
	});
});

describe("round 13 FINDING 2: A → B → A id-reuse with a dropped row", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	// Reopen project A (same id) after a switch to B that DROPPED A's rows. The id-only
	// isSubmitContextCurrent passes again, so a row-dependent continuation must additionally
	// require the row to STILL EXIST. The classification:
	//   PRE-submit gate  → do NOT submit (no charge).
	//   POST-submit cont → write the server marker (charged job stays recoverable) but skip
	//                      ALL local row/poll work (no phantom poll, no resurrected row).

	it("generateCover PRE-submit: row dropped during saveState await → NEVER submits (no charge)", async () => {
		// A → B → A lands DURING the saveState await (before submit). The pre-submit gate now
		// requires the temp row to still exist; it was dropped when B opened, so even though A
		// is open again the gate must bail WITHOUT charging.
		const mockEditor = editor();
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		let resolveSave!: () => void;
		vi.spyOn(projectStore, "saveState").mockReturnValue(
			new Promise<void>((resolve) => { resolveSave = resolve; }),
		);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "p", tier: "sfx-pro" });

		const gen = aiJobsStore.generateCover(mockEditor, "Clean the panel");
		for (let i = 0; i < 4; i++) await Promise.resolve();
		expect(aiJobsStore.activeJobs).toHaveLength(1);

		// Switch A → B (drops A's temp row), then REOPEN A (same id) — all during the await.
		aiJobsStore.cancelPollsForProject("project-1");
		projectStore.__setProjectForTesting(project({ projectId: "project-2" }));
		projectStore.__setProjectForTesting(project({ projectId: "project-1" }));

		resolveSave();
		await gen;
		for (let i = 0; i < 4; i++) await Promise.resolve();

		// Project A is open again, BUT the temp row was gone → no charge, no row, no poll.
		expect(projectStore.isProjectContextCurrent("project-1")).toBe(true);
		expect(api.submitAiJob).not.toHaveBeenCalled();
		expect(aiJobsStore.queue).toEqual([]);
	});

	it("generateCover POST-submit: row dropped during submit await → MARKER-only, no phantom poll", async () => {
		// A → B → A lands DURING the submitAiJob await (post-submit, charged). A is open again
		// so the id-only check would resurrect the temp row (no-op) and arm a PHANTOM poll. The
		// rowStillPresent term routes this into the marker-only branch: server marker written
		// for the charged job, NO local row, NO poll.
		vi.useFakeTimers();
		const mockEditor = editor();
		const createMarker = vi
			.spyOn(projectStore, "createAiReviewMarker")
			.mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		let resolveSubmit!: (v: unknown) => void;
		vi.mocked(api.submitAiJob).mockReturnValue(
			new Promise((resolve) => { resolveSubmit = resolve; }) as any,
		);
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" } as any);

		const gen = aiJobsStore.generateCover(mockEditor, "Clean the panel");
		await Promise.resolve();
		await Promise.resolve();
		expect(aiJobsStore.activeJobs).toHaveLength(1);

		// Switch A → B (drops the temp row), then REOPEN A — during the submit await.
		aiJobsStore.cancelPollsForProject("project-1");
		projectStore.__setProjectForTesting(project({ projectId: "project-2" }));
		projectStore.__setProjectForTesting(project({ projectId: "project-1" }));

		// Resolve the (charging) submit: the continuation runs with A open but the row gone.
		resolveSubmit({ jobId: "job-1", prompt: "p", tier: "sfx-pro" });
		await gen;
		for (let i = 0; i < 6; i++) await Promise.resolve();

		// Marker WAS written server-side for the owner (charged job stays recoverable)...
		expect(createMarker).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: "job-1" }),
			expect.objectContaining({ forProjectId: "project-1" }),
		);
		// ...but NO local row was resurrected and NO phantom poll was armed.
		expect(aiJobsStore.queue).toEqual([]);
		vi.mocked(api.getAiStatus).mockClear();
		await vi.advanceTimersByTimeAsync(4000);
		expect(api.getAiStatus).not.toHaveBeenCalled();
	});

	it("batch POST-submit: row dropped during submit await → MARKER-only, no phantom poll", async () => {
		// Same A → B → A for the batch path: discardSwitchedAwayJob now bails on the row-gone
		// case too, so the caller writes the owner marker (not torn down) and skips updateJob +
		// pollBatchJob. No phantom poll, no resurrected row, slot count stays clean.
		vi.useFakeTimers();
		const mockEditor = editor();
		const createMarker = vi
			.spyOn(projectStore, "createAiReviewMarker")
			.mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		let resolveSubmit!: (v: unknown) => void;
		vi.mocked(api.submitAiJob).mockReturnValue(
			new Promise((resolve) => { resolveSubmit = resolve; }) as any,
		);
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" } as any);

		void aiJobsStore.addBatchJobs(mockEditor, [{ x: 0, y: 0, w: 100, h: 100 }]);
		for (let i = 0; i < 4; i++) await Promise.resolve();
		expect(aiJobsStore.queueStats.processing).toBe(1);

		// Switch A → B (drops the batch row), then REOPEN A — during the submit await.
		aiJobsStore.cancelPollsForProject("project-1");
		projectStore.__setProjectForTesting(project({ projectId: "project-2" }));
		projectStore.__setProjectForTesting(project({ projectId: "project-1" }));

		resolveSubmit({ jobId: "batch-job-1", tier: "sfx-pro" });
		for (let i = 0; i < 6; i++) await Promise.resolve();

		// Owner marker written for the charged job; row NOT resurrected; slot count clean.
		expect(createMarker).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: "batch-job-1" }),
			expect.objectContaining({ forProjectId: "project-1" }),
		);
		expect(aiJobsStore.queue).toEqual([]);
		aiJobsStore.__assertSlotInvariant();
		expect(aiJobsStore.queueStats.processing).toBe(0);

		// No phantom poll for the gone row.
		vi.mocked(api.getAiStatus).mockClear();
		await vi.advanceTimersByTimeAsync(4000);
		expect(api.getAiStatus).not.toHaveBeenCalled();
	});

	it("control: A → B → A with the row STILL PRESENT submits + polls normally (gate not over-eager)", async () => {
		// When the row was NOT dropped (a benign same-id rerender, no cancelPollsForProject),
		// the row-present gate must still pass so a legitimate generation submits and polls.
		vi.useFakeTimers();
		const mockEditor = editor();
		vi.spyOn(projectStore, "createAiReviewMarker").mockResolvedValue({ id: "marker-1" } as any);
		vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(undefined as any);
		vi.spyOn(projectStore, "saveState").mockResolvedValue(undefined);
		vi.mocked(api.submitAiJob).mockResolvedValue({ jobId: "job-1", prompt: "p", tier: "sfx-pro" });
		vi.mocked(api.getAiStatus).mockResolvedValue({ status: "processing" } as any);

		await aiJobsStore.generateCover(mockEditor, "Clean the panel");
		for (let i = 0; i < 6; i++) await Promise.resolve();

		// The row was never dropped → the submit fired and a real poll is armed.
		expect(api.submitAiJob).toHaveBeenCalledTimes(1);
		expect(aiJobsStore.activeJobs).toHaveLength(1);
		expect(aiJobsStore.activeJobs[0].remoteJobId).toBe("job-1");
	});
});

describe("restoreMissingRows prefers the discard-time row (round 14)", () => {
	it("restores the POLLABLE copy (with remoteJobId) instead of the stale pre-flip snapshot", async () => {
		const mockEditor = editor();
		// Snapshot BEFORE the submit resolves: rows have no remoteJobId yet.
		let resolveSubmit: ((v: unknown) => void) | undefined;
		vi.mocked(api.submitAiJob).mockImplementation(
			() => new Promise((resolve) => { resolveSubmit = resolve; }),
		);
		await aiJobsStore.addBatchJobs(mockEditor, [{ x: 0, y: 0, w: 100, h: 100 }]);
		for (let i = 0; i < 8; i++) await Promise.resolve();
		const previousId = projectStore.project!.projectId;
		const snapshot = aiJobsStore.snapshotRowsForProject(previousId);
		expect(snapshot[0].remoteJobId).toBeUndefined();

		// The create flow flips the open project; the submit then RESOLVES with the
		// real jobId and the continuation discards the (now switched-away) row —
		// stashing the discard-time copy that carries remoteJobId.
		projectStore.__setProjectForTesting(project({ projectId: "123e4567-e89b-12d3-a456-426614179999" }));
		resolveSubmit!({ jobId: "remote-restored-1" });
		for (let i = 0; i < 8; i++) await Promise.resolve();
		expect(aiJobsStore.queue.find((j) => j.projectId === previousId)).toBeUndefined();

		// Rollback: restoring from the stale snapshot must yield the DISCARD-TIME
		// row — pollable (remoteJobId present), so resumePolling won't skip it.
		aiJobsStore.restoreMissingRows(snapshot);
		const restored = aiJobsStore.queue.find((j) => j.projectId === previousId);
		expect(restored).toBeDefined();
		expect(restored!.remoteJobId).toBe("remote-restored-1");
	});
});
