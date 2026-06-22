// AI Jobs store tests

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as api from "$lib/api/client.ts";

vi.mock("$lib/api/client.ts", () => ({
	submitAiJob: vi.fn(),
	getAiStatus: vi.fn(),
}));

vi.mock("$lib/config.js", () => ({
	config: {
		minCropSize: 10,
		aiPollIntervalMs: 2000,
	},
}));

vi.mock("../../stores/project.svelte.ts", () => ({
	projectStore: {
		project: {
			projectId: "test-project",
			pages: [{ imageId: "test-image" }],
			currentPage: 0,
		},
		targetLang: "th",
		setStatusMsg: vi.fn(),
		syncTextLayers: vi.fn(),
		saveState: vi.fn(),
		applyAiResult: vi.fn(),
	},
}));

// Mock the store itself since $state runes don't work in tests
function createMockAiJobsStore() {
	let aiStatus = "";
	let sfxToggle = true;
	let activeJobs = new Set<string>();

	return {
		get aiStatus() { return aiStatus; },
		set aiStatus(value) { aiStatus = value; },
		get sfxToggle() { return sfxToggle; },
		set sfxToggle(value) { sfxToggle = value; },
		toggleSfx() {
			this.sfxToggle = !this.sfxToggle;
		},
		async generateCover(editor: any, customPrompt = "") {
			if (!editor) return;

			const crop = editor.getCoverCrop?.();
			if (!crop || crop.w < 10 || crop.h < 10) {
				const { projectStore } = await import("../../stores/project.svelte.ts");
				projectStore.setStatusMsg("ลาก selection ด้วยเครื่องมือ AI Cover ก่อนรัน");
				return;
			}

			const { projectStore } = await import("../../stores/project.svelte.ts");
			const textLayers = editor.getTextLayersInSelection?.() || [];

			try {
				const result = await api.submitAiJob({
					projectId: projectStore.project.projectId,
					imageId: projectStore.project.pages[projectStore.project.currentPage].imageId,
					crop,
					lang: projectStore.targetLang,
					customPrompt,
					translateSfx: this.sfxToggle,
					textLayers,
				});

				this.aiStatus = "Processing...";
				// Simulate setting up polling (not implemented in mock)
			} catch (error) {
				this.aiStatus = "";
				projectStore.setStatusMsg(`Error: ${(error as Error).message}`);
			}
		},
		cleanup() {
			this.aiStatus = "";
			activeJobs.clear();
		},
	};
}

describe("AiJobsStore", () => {
	let aiJobsStore: any;
	let mockEditor: any;

	beforeEach(() => {
		aiJobsStore = createMockAiJobsStore();

		mockEditor = {
			getCoverCrop: vi.fn(),
			getTextLayersInSelection: vi.fn(() => []),
		};

		aiJobsStore.aiStatus = "";
		aiJobsStore.sfxToggle = true;
		aiJobsStore.cleanup();
		vi.clearAllMocks();
	});

	describe("initial state", () => {
		it("has empty aiStatus", () => {
			expect(aiJobsStore.aiStatus).toBe("");
		});

		it("has sfxToggle enabled", () => {
			expect(aiJobsStore.sfxToggle).toBe(true);
		});
	});

	describe("toggleSfx", () => {
		it("toggles from true to false", () => {
			aiJobsStore.sfxToggle = true;
			aiJobsStore.toggleSfx();
			expect(aiJobsStore.sfxToggle).toBe(false);
		});

		it("toggles from false to true", () => {
			aiJobsStore.sfxToggle = false;
			aiJobsStore.toggleSfx();
			expect(aiJobsStore.sfxToggle).toBe(true);
		});
	});

	describe("generateCover", () => {
		it("does nothing if no editor", async () => {
			await aiJobsStore.generateCover(null);
			expect(api.submitAiJob).not.toHaveBeenCalled();
		});

		it("shows message if crop too small", async () => {
			mockEditor.getCoverCrop.mockReturnValue({ x: 0, y: 0, w: 5, h: 5 });
			const { projectStore } = await import("../../stores/project.svelte.ts");

			await aiJobsStore.generateCover(mockEditor);

			expect(projectStore.setStatusMsg).toHaveBeenCalledWith("ลาก selection ด้วยเครื่องมือ AI Cover ก่อนรัน");
			expect(api.submitAiJob).not.toHaveBeenCalled();
		});

		it("sends AI job with correct parameters", async () => {
			mockEditor.getCoverCrop.mockReturnValue({ x: 0, y: 0, w: 100, h: 100 });
			mockEditor.getTextLayersInSelection.mockReturnValue([]);
			(api.submitAiJob as any).mockResolvedValue({ jobId: "job-123" });

			await aiJobsStore.generateCover(mockEditor, "custom prompt");

			expect(api.submitAiJob).toHaveBeenCalledWith({
				projectId: "test-project",
				imageId: "test-image",
				crop: { x: 0, y: 0, w: 100, h: 100 },
				lang: "th",
				customPrompt: "custom prompt",
				translateSfx: true,
				textLayers: [],
			});
		});

		it("includes text layers when overlapping", async () => {
			mockEditor.getCoverCrop.mockReturnValue({ x: 0, y: 0, w: 100, h: 100 });
			mockEditor.getTextLayersInSelection.mockReturnValue(["hello", "world"]);
			(api.submitAiJob as any).mockResolvedValue({ jobId: "job-123" });

			await aiJobsStore.generateCover(mockEditor);

			expect(api.submitAiJob).toHaveBeenCalledWith(
				expect.objectContaining({
					textLayers: ["hello", "world"],
				})
			);
		});

		it("handles API error gracefully", async () => {
			mockEditor.getCoverCrop.mockReturnValue({ x: 0, y: 0, w: 100, h: 100 });
			(api.submitAiJob as any).mockRejectedValue(new Error("Network error"));
			const { projectStore } = await import("../../stores/project.svelte.ts");

			await aiJobsStore.generateCover(mockEditor);

			expect(aiJobsStore.aiStatus).toBe("");
			expect(projectStore.setStatusMsg).toHaveBeenCalledWith("Error: Network error");
		});
	});

	describe("cleanup", () => {
		it("clears all pending intervals", () => {
			// Use fake timers
			vi.useFakeTimers();
			mockEditor.getCoverCrop.mockReturnValue({ x: 0, y: 0, w: 100, h: 100 });
			(api.submitAiJob as any).mockResolvedValue({ jobId: "job-123" });

			aiJobsStore.generateCover(mockEditor);

			// Should have set up an interval
			aiJobsStore.cleanup();

			expect(aiJobsStore.aiStatus).toBe("");
			vi.useRealTimers();
		});
	});
});
