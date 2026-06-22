import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import AiReviewMarkersPanel from "$lib/components/AiReviewMarkersPanel.svelte";
import { aiJobsStore } from "$lib/stores/ai-jobs.svelte.ts";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { AiReviewMarker, Page, ProjectState } from "$lib/types.js";

const now = "2026-05-14T00:00:00.000Z";

function marker(overrides: Partial<AiReviewMarker> = {}): AiReviewMarker {
	return {
		id: "marker-1",
		jobId: "job-123456789",
		pageIndex: 0,
		imageId: "image-1.webp",
		region: { x: 10, y: 20, w: 120, h: 80 },
		status: "needs_review",
		tier: "sfx-pro",
		resultImageId: "result-image-123456789",
		assignee: "nina",
		costEstimate: {
			estimatedThb: 1.25,
			reserveThb: 1.75,
			currency: "THB",
			creditUnits: 9,
		},
		linkedCommentIds: ["comment-1"],
		linkedTaskIds: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

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

function project(markers: AiReviewMarker[], overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "project-1",
		name: "AI review marker test",
		createdAt: now,
		pages: [page()],
		currentPage: 0,
		targetLang: "en",
		tasks: [],
		activityLog: [],
		comments: [{
			id: "comment-1",
			pageIndex: 0,
			body: "Check AI edge",
			author: "lead",
			status: "open",
			createdAt: now,
			updatedAt: now,
		}],
		aiReviewMarkers: markers,
		reviewDecisions: [],
		workspaceMessages: [],
		versionReviewRequests: [],
		...overrides,
	};
}

beforeEach(() => {
	vi.restoreAllMocks();
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	editorStore.editor = null;
	editorStore.selectedImageLayer = null;
});

describe("AiReviewMarkersPanel", () => {
	it("makes automatic focus selection explicit before the user chooses an AI result", async () => {
		projectStore.__setProjectForTesting(project([
			marker({ id: "marker-auto", jobId: "job-auto" }),
			marker({
				id: "marker-applied",
				jobId: "job-applied",
				status: "applied",
				region: { x: 40, y: 50, w: 80, h: 80 },
			}),
		]));

		render(AiReviewMarkersPanel);

		const focusCard = screen.getByRole("region", { name: "ผล AI ที่เลือก" });
		expect(within(focusCard).getByText(/แนะนำอัตโนมัติ/)).toBeTruthy();
		expect(within(focusCard).getByText(/ยังไม่ได้เลือกผลเอง/)).toBeTruthy();
		expect(projectStore.selectedAiReviewMarkerId).toBeNull();
	});

	it("starts with a focused AI review card before marker rows", async () => {
		const updateStatus = vi.spyOn(projectStore, "updateAiReviewMarkerStatus").mockResolvedValue(undefined);
		const placeAiResult = vi.spyOn(projectStore, "placeAiReviewMarkerResultAsImageLayer").mockImplementation(async (markerId: string) => ({
			id: `ai-result-${markerId}`,
			imageId: "result-image-123456789",
			imageName: "result-image-123456789",
			originalName: `AI result ${markerId}`,
			x: 10,
			y: 20,
			w: 120,
			h: 80,
			rotation: 0,
			opacity: 1,
			visible: true,
			locked: false,
			index: 0,
			role: "overlay",
		}));
		const createComment = vi.spyOn(projectStore, "createAiReviewMarkerComment").mockResolvedValue(null);
		const linkTask = vi.spyOn(projectStore, "linkAiReviewMarkerReviewTask").mockResolvedValue(null);
		projectStore.__setProjectForTesting(project([
			marker(),
			marker({
				id: "marker-2",
				jobId: "job-2",
				region: { x: 40, y: 50, w: 80, h: 80 },
				status: "accepted",
			}),
		]));
		projectStore.selectAiReviewMarker("marker-1");

		const { container } = render(AiReviewMarkersPanel);

		const focusCard = screen.getByRole("region", { name: "ผล AI ที่เลือก" });
		expect(within(focusCard).getByText(/รอรีวิว/)).toBeTruthy();
		expect(within(focusCard).getByText("รีวิวผล AI นี้")).toBeTruthy();
		expect(within(focusCard).getByText("ผล AI พร้อมให้ตรวจภาพ.")).toBeTruthy();
		expect(within(focusCard).getByText("ทำต่อ")).toBeTruthy();
		expect(within(focusCard).getByText("รีวิวผลก่อนยืนยัน")).toBeTruthy();
		const focusPreview = within(focusCard).getByTestId("ai-marker-focus-preview");
		expect(within(focusPreview).getByTestId("ai-result-comparison-slider")).toBeTruthy();
		expect(within(focusCard).queryByText("9 เครดิต")).toBeNull();
		expect(within(focusCard).queryByText("0 งาน / 1 โน้ต")).toBeNull();
		expect(within(focusCard).queryByText("@nina")).toBeNull();
		expect(screen.getByText("รายละเอียดผล AI")).toBeTruthy();
		expect(screen.getByText("9 เครดิต / 0 งาน / 1 โน้ต / @nina")).toBeTruthy();
		expect(container.querySelectorAll(".ai-marker-result-state.placement")).toHaveLength(1);
		expect(screen.getAllByText("รอวาง").length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText(/ผลพร้อม/).length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText(/ยังไม่วาง/)).toBeTruthy();

		const list = container.querySelector(".ai-marker-list")!;
		expect(Array.from(container.querySelector(".ai-marker-panel")!.children).indexOf(focusCard)).toBeLessThan(
			Array.from(container.querySelector(".ai-marker-panel")!.children).indexOf(list)
		);

		expect(within(focusCard).queryByRole("button", { name: "วางเป็นเลเยอร์แก้" })).toBeNull();
		expect(within(focusCard).queryByRole("button", { name: "วาง Layer ตอนนี้" })).toBeNull();
		expect(within(focusCard).queryByRole("button", { name: "ยอมรับและแปลงเป็นเลเยอร์แก้ไข" })).toBeNull();
		await fireEvent.click(within(focusCard).getByRole("button", { name: "ยืนยันผลผ่าน" }));
		await fireEvent.click(screen.getByRole("button", { name: /เปิดผล AI P1 SFX Pro ผ่านรีวิว ยังไม่วาง/ }));
		const acceptedFocusCard = screen.getByRole("region", { name: "ผล AI ที่เลือก" });
		expect(within(acceptedFocusCard).getByText("วางเลเยอร์ AI ก่อน Export")).toBeTruthy();
		await fireEvent.click(within(acceptedFocusCard).getByRole("button", { name: "วางเลเยอร์ AI" }));
		expect(within(focusCard).queryByRole("button", { name: "ขอรันใหม่" })).toBeNull();
		await fireEvent.click(screen.getByText("รายละเอียดผล AI"));
		await fireEvent.click(screen.getByRole("button", { name: "ขอรันใหม่" }));
		await fireEvent.click(screen.getByRole("button", { name: "เพิ่มโน้ตแก้" }));
		await fireEvent.click(screen.getByRole("button", { name: "สร้างงานแก้" }));

		expect(updateStatus).toHaveBeenCalledWith("marker-1", "accepted");
		expect(placeAiResult).toHaveBeenCalledWith("marker-2", null);
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.imageInspectorFocusLayerId).toBe("ai-result-marker-2");
		expect(updateStatus).not.toHaveBeenCalledWith("marker-1", "applied");
		expect(updateStatus).toHaveBeenCalledWith("marker-2", "retry_requested");
		expect(createComment).toHaveBeenCalledWith("marker-2", undefined);
		expect(linkTask).toHaveBeenCalledWith("marker-2", "nina");
	});

	it("warns when the selected applied result hides unresolved page AI debt", async () => {
		const state = project([
			marker({
				id: "review-ready",
				jobId: "job-review",
				status: "needs_review",
				createdAt: now,
			}),
			marker({
				id: "accepted-ready",
				jobId: "job-accepted",
				status: "accepted",
				createdAt: "2026-05-14T00:00:01.000Z",
			}),
			marker({
				id: "applied-ready",
				jobId: "job-applied",
				status: "applied",
				createdAt: "2026-05-14T00:00:02.000Z",
			}),
		]);
		state.pages[0].imageLayers = [{
			id: "ai-result-applied-ready",
			imageId: "result-image-123456789",
			imageName: "result-image-123456789",
			originalName: "AI result",
			x: 10,
			y: 20,
			w: 120,
			h: 80,
			rotation: 0,
			opacity: 1,
			visible: true,
			locked: false,
			index: 0,
			role: "overlay",
		}];
		projectStore.__setProjectForTesting(state);
		projectStore.selectAiReviewMarker("applied-ready");

		render(AiReviewMarkersPanel);

		const debtCard = screen.getByRole("region", { name: "งาน AI ที่ยังค้าง" });
		expect(within(debtCard).getByText("ยังมีผล AI ต้องทำต่อ")).toBeTruthy();
		expect(within(debtCard).getByText("1 รอรีวิว · 1 รอวาง")).toBeTruthy();
		expect(within(debtCard).getByText("รายการที่เลือกอาจวางแล้ว แต่ขอบเขตนี้ยังมีผลที่ต้องรีวิวหรือวางก่อนปิดงาน.")).toBeTruthy();
		expect(within(screen.getByRole("region", { name: "ผล AI ที่เลือก" })).getAllByText("วางแล้ว").length).toBeGreaterThanOrEqual(1);

		await fireEvent.click(within(debtCard).getByRole("button", { name: "เปิด AI 2" }));
		expect(projectStore.selectedAiReviewMarkerId).toBe("accepted-ready");
		expect(screen.getByText("วางเลเยอร์ AI ก่อน Export")).toBeTruthy();
	});

	it("uses scope-truthful empty copy for chapter AI review scope", async () => {
		projectStore.__setProjectForTesting(project([]));
		render(AiReviewMarkersPanel);

		expect(screen.getByText("หน้านี้ยังไม่มีผล AI ให้ตรวจ.")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "ดูผล AI ทั้งตอน 0 ผล" }));

		expect(screen.getByText("ทั้งตอนยังไม่มีผล AI ให้ตรวจ.")).toBeTruthy();
	});

	it("does not expose disabled refresh controls before AI results can load", async () => {
		const { rerender } = render(AiReviewMarkersPanel);

		expect(screen.queryByRole("button", { name: "โหลดผล AI ใหม่" })).toBeNull();

		projectStore.__setProjectForTesting(project([]));
		projectStore.aiReviewMarkersLoading = true;
		await rerender({});

		expect(screen.getByText("กำลังโหลด")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "โหลดผล AI ใหม่" })).toBeNull();
	});

	it("can switch to chapter AI markers and jump to another page marker", async () => {
		const focusImageRegion = vi.fn(() => true);
		editorStore.editor = { focusImageRegion } as any;
		const goToPage = vi.spyOn(projectStore, "goToPage").mockImplementation(async (index) => {
			if (projectStore.project) projectStore.project.currentPage = index;
			return true;
		});
		projectStore.__setProjectForTesting(project([
			marker(),
			marker({
				id: "marker-page-2",
				jobId: "job-page-2",
				pageIndex: 1,
				imageId: "image-2.webp",
				region: { x: 60, y: 90, w: 140, h: 100 },
				tier: "clean-pro",
			}),
		], {
			pages: [
				page(),
				page({ imageId: "image-2.webp", imageName: "image-2.webp" }),
			],
		}));

		const { container } = render(AiReviewMarkersPanel);

		expect(container.querySelectorAll(".ai-marker-row")).toHaveLength(0);
		await fireEvent.click(screen.getByRole("button", { name: "ดูผล AI ทั้งตอน 2 ผล" }));
		expect(screen.getByText("2 ผล ทั้งตอน")).toBeTruthy();
		expect(container.querySelectorAll(".ai-marker-row")).toHaveLength(1);

		await fireEvent.click(screen.getByRole("button", { name: "เปิดผล AI P2 Clean Pro รอรีวิว ผลพร้อม" }));

		expect(goToPage).toHaveBeenCalledWith(1, editorStore.editor);
		await waitFor(() => expect(focusImageRegion).toHaveBeenCalledWith({ x: 60, y: 90, w: 140, h: 100 }));
		expect(projectStore.selectedAiReviewMarkerId).toBe("marker-page-2");
		expect(projectStore.statusMsg).toBe("โฟกัสผล AI P2 แล้ว");
	});

	it("does not silently hide AI results beyond the first eight rows", async () => {
		const markers = Array.from({ length: 10 }, (_, index) => marker({
			id: `marker-${index + 1}`,
			jobId: `job-${index + 1}`,
			region: { x: 10 + index * 5, y: 20, w: 120, h: 80 },
		}));
		projectStore.__setProjectForTesting(project(markers));

		const { container } = render(AiReviewMarkersPanel);

		expect(container.querySelectorAll(".ai-marker-row")).toHaveLength(8);
		await fireEvent.click(screen.getByRole("button", { name: "แสดงผล AI อีก 1 รายการ" }));
		expect(container.querySelectorAll(".ai-marker-row")).toHaveLength(9);
		await fireEvent.click(screen.getByRole("button", { name: "ย่อรายการ" }));
		expect(container.querySelectorAll(".ai-marker-row")).toHaveLength(8);
	});

	it("keeps placement and review blockers visible before completed AI rows", async () => {
		const markers = [
			...Array.from({ length: 8 }, (_, index) => marker({
				id: `applied-${index + 1}`,
				jobId: `job-applied-${index + 1}`,
				status: "applied" as const,
				createdAt: `2026-05-14T00:00:${10 + index}.000Z`,
			})),
			marker({
				id: "accepted-hidden-risk",
				jobId: "job-accepted-hidden-risk",
				status: "accepted",
				createdAt: "2026-05-14T00:00:30.000Z",
			}),
			marker({
				id: "review-hidden-risk",
				jobId: "job-review-hidden-risk",
				status: "needs_review",
				createdAt: "2026-05-14T00:00:31.000Z",
			}),
		];
		projectStore.__setProjectForTesting(project(markers));

		const { container } = render(AiReviewMarkersPanel);
		const focusCard = screen.getByRole("region", { name: "ผล AI ที่เลือก" });
		const visibleRows = Array.from(container.querySelectorAll(".ai-marker-row")).map((row) => row.textContent ?? "");

		expect(within(focusCard).getByText("วางเลเยอร์ AI ก่อน Export")).toBeTruthy();
		expect(within(focusCard).getByText(/AI 9/)).toBeTruthy();
		expect(visibleRows).toHaveLength(8);
		expect(visibleRows[0]).toContain("รอรีวิว");
		expect(visibleRows[0]).toContain("AI 10");
		expect(visibleRows.join(" ")).not.toContain("AI 8");
	});

	it("opens the generated AI result layer when an applied marker already has one", async () => {
		const focusImageRegion = vi.fn(() => true);
		const selectImageLayer = vi.fn();
		editorStore.editor = { focusImageRegion, selectImageLayer } as any;
		editorUiStore.setRightPanelMode("ai");
		const applied = marker({
			id: "applied-marker",
			status: "applied",
			resultImageId: "result-image-123456789",
		});
		const state = project([applied]);
		state.pages[0].imageLayers = [{
			id: "ai-result-applied-marker",
			imageId: "result-image-123456789",
			imageName: "result-image-123456789",
			originalName: "AI result P1",
			x: 10,
			y: 20,
			w: 120,
			h: 80,
			rotation: 0,
			opacity: 1,
			visible: true,
			locked: false,
			index: 0,
			role: "overlay",
		}];
		projectStore.__setProjectForTesting(state);
		projectStore.selectAiReviewMarker("applied-marker");

		render(AiReviewMarkersPanel);
		const focusCard = screen.getByRole("region", { name: "ผล AI ที่เลือก" });
		await fireEvent.click(within(focusCard).getByRole("button", { name: "ดูพื้นที่" }));
		expect(focusImageRegion).toHaveBeenCalledWith(applied.region);
		expect(selectImageLayer).not.toHaveBeenCalled();
		expect(editorUiStore.rightPanelMode).toBe("ai");

		expect(focusCard.textContent).toContain("เปิดเลเยอร์ AI");

		await fireEvent.click(within(focusCard).getByRole("button", { name: "เปิดเลเยอร์ AI" }));

		expect(selectImageLayer).toHaveBeenCalledWith("ai-result-applied-marker");
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.imageInspectorFocusLayerId).toBe("ai-result-applied-marker");
	});

	it("focuses the review card from the selected applied AI image layer when no marker is explicitly selected", () => {
		const applied = marker({
			id: "selected-layer-marker",
			status: "applied",
			resultImageId: "result-image-123456789",
		});
		const staleReview = marker({
			id: "stale-review",
			jobId: "job-stale",
			status: "needs_review",
			region: { x: 60, y: 70, w: 90, h: 80 },
		});
		const state = project([staleReview, applied]);
		state.pages[0].imageLayers = [{
			id: "ai-result-selected-layer-marker",
			imageId: "result-image-123456789",
			imageName: "result-image-123456789",
			originalName: "AI result P1",
			x: 10,
			y: 20,
			w: 120,
			h: 80,
			rotation: 0,
			opacity: 1,
			visible: true,
			locked: false,
			index: 0,
			role: "overlay",
		}];
		projectStore.__setProjectForTesting(state);
		projectStore.selectAiReviewMarker("stale-review");
		editorStore.selectedImageLayer = state.pages[0].imageLayers[0];

		render(AiReviewMarkersPanel);

		const focusCard = screen.getByRole("region", { name: "ผล AI ที่เลือก" });
		expect(within(focusCard).getAllByText("วางแล้ว").length).toBeGreaterThanOrEqual(1);
		expect(within(focusCard).getByText("แก้ต่อที่เลเยอร์ AI")).toBeTruthy();
		expect(within(focusCard).getByRole("button", { name: "เปิดเลเยอร์ AI" })).toBeTruthy();
	});

	it("shows a receipt instead of a disabled focus-card jump while page navigation is busy", () => {
		projectStore.__setProjectForTesting(project([marker()]));
		projectStore.saveSyncStatus = "saving";

		const { container } = render(AiReviewMarkersPanel);

		const focusCard = screen.getByRole("region", { name: "ผล AI ที่เลือก" });
		expect(within(focusCard).getByRole("button", { name: "ยืนยันผลผ่าน" })).toBeTruthy();
		expect(within(focusCard).queryByRole("button", { name: "ดูพื้นที่" })).toBeNull();
		expect(within(focusCard).getByText("กำลังเปิดพื้นที่")).toBeTruthy();
		expect(container.querySelectorAll(".ai-marker-focus-actions button:disabled")).toHaveLength(0);
	});

	it("jumps to another page before focusing an applied AI result layer", async () => {
		const focusImageRegion = vi.fn(() => true);
		const selectImageLayer = vi.fn();
		editorStore.editor = { focusImageRegion, selectImageLayer } as any;
		const goToPage = vi.spyOn(projectStore, "goToPage").mockImplementation(async (index) => {
			if (projectStore.project) projectStore.project.currentPage = index;
			return true;
		});
		const pageOneMarker = marker();
		const pageTwoApplied = marker({
			id: "page-2-applied",
			jobId: "job-page-2",
			pageIndex: 1,
			imageId: "image-2.webp",
			status: "applied",
			resultImageId: "result-page-2.webp",
			tier: "clean-pro",
			region: { x: 60, y: 90, w: 140, h: 100 },
		});
		const state = project([pageOneMarker, pageTwoApplied], {
			pages: [
				page(),
				page({
					imageId: "image-2.webp",
					imageName: "image-2.webp",
					imageLayers: [{
						id: "ai-result-page-2-applied",
						imageId: "result-page-2.webp",
						imageName: "result-page-2.webp",
						originalName: "ผล AI หน้า 2",
						x: 60,
						y: 90,
						w: 140,
						h: 100,
						rotation: 0,
						opacity: 1,
						visible: true,
						locked: false,
						index: 0,
						role: "overlay",
					}],
				}),
			],
		});
		projectStore.__setProjectForTesting(state);

		render(AiReviewMarkersPanel);
		await fireEvent.click(screen.getByRole("button", { name: "ดูผล AI ทั้งตอน 2 ผล" }));
		await fireEvent.click(screen.getByRole("button", { name: "เปิดผล AI P2 Clean Pro วางแล้ว" }));

		expect(goToPage).toHaveBeenCalledWith(1, editorStore.editor);
		await waitFor(() => expect(selectImageLayer).toHaveBeenCalledWith("ai-result-page-2-applied"));
		expect(projectStore.selectedAiReviewMarkerId).toBe("page-2-applied");
		expect(focusImageRegion).toHaveBeenCalledWith({ x: 60, y: 90, w: 140, h: 100 });
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.imageInspectorFocusLayerId).toBe("ai-result-page-2-applied");
	});

	it("does not claim an applied AI marker is layer-backed when the layer is missing", () => {
		projectStore.__setProjectForTesting(project([
			marker({
				id: "missing-layer-marker",
				status: "applied",
				resultImageId: "result-image-missing.webp",
			}),
		]));

		render(AiReviewMarkersPanel);

		const focusCard = screen.getByRole("region", { name: "ผล AI ที่เลือก" });
		expect(focusCard.textContent).toContain("เลเยอร์หาย");
		expect(focusCard.textContent).not.toContain("เป็นเลเยอร์");
	});

	it("keeps retry-requested markers honest instead of showing stale provider errors", async () => {
		const rerunMarker = vi.spyOn(aiJobsStore, "rerunAiReviewMarker").mockResolvedValue(true);
		projectStore.__setProjectForTesting(project([
			marker({
				status: "retry_requested",
				error: "Worker failed while generating SFX",
			}),
		]));

		render(AiReviewMarkersPanel);

		const focusCard = screen.getByRole("region", { name: "ผล AI ที่เลือก" });
		expect(within(focusCard).getByText("ขอรันใหม่แล้ว")).toBeTruthy();
		expect(within(focusCard).getByText("บันทึกว่าต้องรันใหม่แล้ว เก็บโน้ตหรืองานแก้ไว้จนกว่าจะรันพื้นที่เดิมอีกครั้ง.")).toBeTruthy();
		expect(within(focusCard).queryByText("Worker failed while generating SFX")).toBeNull();
		// ALLOWLIST: even the "keep for audit" note funnels through sanitizeAiMarkerError,
		// so the raw provider text never renders — it shows the generic message instead.
		expect(screen.queryByText(/Worker failed while generating SFX/)).toBeNull();
		expect(screen.getByText("เก็บ error เดิมไว้ดูย้อนหลัง: เกิดข้อผิดพลาดกับบริการ AI (ดูบันทึกระบบ)")).toBeTruthy();

		expect(within(focusCard).queryByRole("button", { name: "รันใหม่จากพื้นที่เดิม" })).toBeNull();
		await fireEvent.click(screen.getByText("รายละเอียดผล AI"));
		expect(screen.queryByRole("button", { name: "ขอรันใหม่" })).toBeNull();
		await fireEvent.click(screen.getByRole("button", { name: "รันใหม่จากพื้นที่เดิม" }));

		expect(rerunMarker).toHaveBeenCalledWith(expect.objectContaining({ id: "marker-1" }), null);
	});

	it("hides completed secondary status commands instead of disabling them", async () => {
		projectStore.__setProjectForTesting(project([
			marker({
				status: "rejected",
				error: "Bad crop",
			}),
		]));

		const { container } = render(AiReviewMarkersPanel);

		await fireEvent.click(screen.getByText("รายละเอียดผล AI"));

		expect(screen.queryByRole("button", { name: "ไม่ใช้ผลนี้" })).toBeNull();
		expect(container.querySelectorAll(".ai-marker-actions button:disabled")).toHaveLength(0);
	});

	it("uses receipts instead of disabled detail-drawer actions while AI review work is loading", async () => {
		projectStore.__setProjectForTesting(project([
			marker({
				status: "failed",
				error: "Worker failed",
			}),
		]));
		projectStore.aiReviewMarkersLoading = true;

		const { container } = render(AiReviewMarkersPanel);

		await fireEvent.click(screen.getByText("รายละเอียดผล AI"));

		const assignee = screen.getByPlaceholderText("ยังไม่กำหนด") as HTMLInputElement;
		expect(assignee.disabled).toBe(false);
		expect(assignee.readOnly).toBe(true);
		expect(screen.getByText("กำลังซิงก์ผล AI")).toBeTruthy();
		expect(container.querySelectorAll(".ai-marker-actions button:disabled")).toHaveLength(0);
	});

	it("uses receipts instead of disabled note/task actions while related stores are loading", async () => {
		projectStore.__setProjectForTesting(project([marker()]));
		projectStore.commentsLoading = true;
		projectStore.workflowLoading = true;

		const { container } = render(AiReviewMarkersPanel);

		await fireEvent.click(screen.getByText("รายละเอียดผล AI"));

		expect(screen.queryByRole("button", { name: "เพิ่มโน้ตแก้" })).toBeNull();
		expect(screen.queryByRole("button", { name: "สร้างงานแก้" })).toBeNull();
		expect(screen.getByText("กำลังซิงก์โน้ต")).toBeTruthy();
		expect(screen.getByText("กำลังซิงก์งานแก้")).toBeTruthy();
		expect(container.querySelectorAll(".ai-marker-actions button:disabled")).toHaveLength(0);
	});

	it("blocks approval and applied actions for failed or retry-requested markers", async () => {
		const updateStatus = vi.spyOn(projectStore, "updateAiReviewMarkerStatus").mockResolvedValue(undefined);
		projectStore.__setProjectForTesting(project([
			marker({
				status: "failed",
				error: "Worker failed while generating SFX",
			}),
			marker({
				id: "marker-retry",
				jobId: "job-retry",
				status: "retry_requested",
				error: "Retry already requested",
			}),
		]));

		const { container } = render(AiReviewMarkersPanel);

		const focusCard = screen.getByRole("region", { name: "ผล AI ที่เลือก" });
		expect(within(focusCard).queryByRole("button", { name: "ยืนยันผลผ่าน" })).toBeNull();
		expect(within(focusCard).queryByRole("button", { name: "วางเป็นเลเยอร์แก้" })).toBeNull();
		expect(within(focusCard).getByRole("button", { name: "เปิดรายละเอียด" })).toBeTruthy();
		expect(container.querySelector(".ai-marker-workflow-actions")).toBeNull();

		await fireEvent.click(container.querySelectorAll(".ai-marker-row")[0]);

		const retryFocusCard = screen.getByRole("region", { name: "ผล AI ที่เลือก" });
		expect(within(retryFocusCard).queryByRole("button", { name: "ยืนยันผลผ่าน" })).toBeNull();
		expect(within(retryFocusCard).queryByRole("button", { name: "วางเป็นเลเยอร์แก้" })).toBeNull();
		expect(within(retryFocusCard).getByRole("button", { name: "เปิดรายละเอียด" })).toBeTruthy();
		expect(updateStatus).not.toHaveBeenCalledWith(expect.any(String), "accepted");
		expect(updateStatus).not.toHaveBeenCalledWith(expect.any(String), "applied");
	});

	it("blocks approval and applied actions when marker image references are stale", async () => {
		const updateStatus = vi.spyOn(projectStore, "updateAiReviewMarkerStatus").mockResolvedValue(undefined);
		projectStore.__setProjectForTesting(project([
			marker({
				imageId: "old-image.webp",
				resultImageId: "result-image-123456789",
				status: "needs_review",
			}),
		]));

		const { container } = render(AiReviewMarkersPanel);

		const focusCard = screen.getByRole("region", { name: "ผล AI ที่เลือก" });
		expect(within(focusCard).getByText("รูปต้นทางเปลี่ยนแล้ว")).toBeTruthy();
		expect(within(focusCard).getByText(/ผล AI นี้ผูกกับรูปเก่า old-image.webp แต่หน้า 1 ตอนนี้ใช้ image-1.webp; รันพื้นที่นี้ใหม่ก่อนยืนยันหรือวางเลเยอร์/)).toBeTruthy();
		expect(within(focusCard).queryByRole("button", { name: "ยืนยันผลผ่าน" })).toBeNull();
		expect(within(focusCard).queryByRole("button", { name: "วางเป็นเลเยอร์แก้" })).toBeNull();
		expect(within(focusCard).getByRole("button", { name: "เปิดรายละเอียดแก้" })).toBeTruthy();
		expect(container.querySelector(".ai-marker-actions")?.textContent).not.toContain("รับผลนี้");
		expect(container.querySelector(".ai-marker-actions")?.textContent).not.toContain("ใช้แล้ว");
		expect(updateStatus).not.toHaveBeenCalled();
	});

	it("surfaces and clears stale linked comments and tasks", async () => {
		const updateMarker = vi.spyOn(projectStore, "updateAiReviewMarker").mockResolvedValue(null);
		projectStore.__setProjectForTesting(project([
			marker({
				status: "retry_requested",
				linkedCommentIds: ["live-comment", "missing-comment"],
				linkedTaskIds: ["live-task", "missing-task"],
			}),
		], {
			comments: [{
				id: "live-comment",
				pageIndex: 0,
				body: "Keep this fix note",
				author: "lead",
				status: "open",
				createdAt: now,
				updatedAt: now,
			}],
			tasks: [{
				id: "live-task",
				type: "review",
				status: "review",
				pageIndex: 0,
				title: "Review live fix",
				createdAt: now,
				updatedAt: now,
			}],
		}));

		const { container } = render(AiReviewMarkersPanel);

		const focusCard = screen.getByRole("region", { name: "ผล AI ที่เลือก" });
		expect(within(focusCard).getByText("โน้ต/งานแก้ที่ผูกไว้หาย")).toBeTruthy();
		expect(within(focusCard).getByText(/ผล AI นี้มีลิงก์ที่หาย: โน้ต missing-comment และงาน missing-task; ล้างลิงก์หรือสร้างงานติดตามใหม่/)).toBeTruthy();
		expect(within(focusCard).queryByText("1/2 งาน / 1/2 โน้ต")).toBeNull();
		expect(screen.getByText("9 เครดิต / 1/2 งาน / 1/2 โน้ต / @nina")).toBeTruthy();

		expect(within(focusCard).queryByRole("button", { name: "ล้างลิงก์ที่หาย" })).toBeNull();
		await fireEvent.click(screen.getByText("รายละเอียดผล AI"));
		await fireEvent.click(screen.getByRole("button", { name: "ล้างลิงก์ที่หาย" }));

		expect(updateMarker).toHaveBeenCalledWith("marker-1", {
			status: "retry_requested",
			linkedCommentIds: ["live-comment"],
			linkedTaskIds: ["live-task"],
		});
		expect(container.querySelector(".ai-marker-workflow-actions")).toBeNull();
	});

	it("uses the primary วางเลเยอร์ AI command for accepted results", async () => {
		const placeAiResult = vi.spyOn(projectStore, "placeAiReviewMarkerResultAsImageLayer").mockImplementation(async (markerId: string) => ({
			id: `ai-result-${markerId}`,
			imageId: "result-image-123456789",
			imageName: "result-image-123456789",
			originalName: `AI result ${markerId}`,
			x: 10,
			y: 20,
			w: 120,
			h: 80,
			rotation: 0,
			opacity: 1,
			visible: true,
			locked: false,
			index: 0,
			role: "overlay",
		}));

		projectStore.__setProjectForTesting(project([
			marker({
				id: "accepted-marker",
				status: "accepted",
				resultImageId: "result-image-123",
			}),
		]));
		projectStore.selectAiReviewMarker("accepted-marker");

		render(AiReviewMarkersPanel);

		const focusCard = screen.getByRole("region", { name: "ผล AI ที่เลือก" });
		const convertBtn = within(focusCard).getByRole("button", { name: "วางเลเยอร์ AI" });
		expect(within(focusCard).queryByRole("button", { name: "ยอมรับและแปลงเป็นเลเยอร์แก้ไข" })).toBeNull();

		await fireEvent.click(convertBtn);
		expect(placeAiResult).toHaveBeenCalledWith("accepted-marker", null);
	});

	it("does not let unreviewed AI results become editable layers from the focus card", async () => {
		const placeAiResult = vi.spyOn(projectStore, "placeAiReviewMarkerResultAsImageLayer").mockResolvedValue(null);

		projectStore.__setProjectForTesting(project([
			marker({
				id: "needs-review-marker",
				status: "needs_review",
				resultImageId: "result-image-123",
			}),
		]));
		projectStore.selectAiReviewMarker("needs-review-marker");

		render(AiReviewMarkersPanel);

		const focusCard = screen.getByRole("region", { name: "ผล AI ที่เลือก" });
		expect(within(focusCard).getByRole("button", { name: "ยืนยันผลผ่าน" })).toBeTruthy();
		expect(within(focusCard).queryByRole("button", { name: "ยอมรับและแปลงเป็นเลเยอร์แก้ไข" })).toBeNull();
		expect(placeAiResult).not.toHaveBeenCalled();
	});

	it("renders a bounded before/after comparison slider for an AI result instead of a full-size dump", async () => {
		vi.spyOn(projectStore, "getImageUrl").mockImplementation(
			(imageId: string) => `https://cdn.test/${imageId}`,
		);
		projectStore.__setProjectForTesting(project([
			marker({
				id: "preview-marker",
				status: "needs_review",
				imageId: "image-1.webp",
				resultImageId: "result-image-987654321",
			}),
		]));
		projectStore.selectAiReviewMarker("preview-marker");

		const { container } = render(AiReviewMarkersPanel);
		await fireEvent.click(screen.getByText("รายละเอียดผล AI"));

		const slider = container.querySelector('[data-testid="ai-result-comparison-slider"]');
		expect(slider).toBeTruthy();
		// Before = source image, After = AI result image — both bounded inside the slider frame.
		const before = slider!.querySelector(".ai-result-before") as HTMLImageElement;
		const after = slider!.querySelector(".ai-result-after") as HTMLImageElement;
		expect(before.getAttribute("src")).toBe("https://cdn.test/image-1.webp");
		expect(after.getAttribute("src")).toBe("https://cdn.test/result-image-987654321");
		// The result is rendered in a fixed-height frame, never the full-size editor canvas.
		expect(slider!.querySelector(".ai-result-frame")).toBeTruthy();
	});

	it("retries a marker with an edited prompt through the moderation-gated retry path", async () => {
		vi.spyOn(projectStore, "getImageUrl").mockImplementation((imageId: string) => `https://cdn.test/${imageId}`);
		const retrySpy = vi
			.spyOn(aiJobsStore, "retryAiReviewMarkerWithPrompt")
			.mockResolvedValue(true);
		const fakeEditor = { updateBackgroundImage: () => {} };
		editorStore.editor = fakeEditor as never;

		projectStore.__setProjectForTesting(project([
			marker({
				id: "retry-marker",
				status: "needs_review",
				imageId: "image-1.webp",
				resultImageId: "result-image-111222333",
			}),
		]));
		projectStore.selectAiReviewMarker("retry-marker");

		render(AiReviewMarkersPanel);
		await fireEvent.click(screen.getByText("รายละเอียดผล AI"));

		// Open the retry-with-prompt editor.
		await fireEvent.click(screen.getByTestId("ai-marker-retry-toggle"));
		const promptInput = screen.getByTestId("ai-marker-retry-prompt") as HTMLTextAreaElement;
		await fireEvent.input(promptInput, { target: { value: "Soften the SFX wording" } });
		await fireEvent.click(screen.getByTestId("ai-marker-retry-submit"));

		expect(retrySpy).toHaveBeenCalledWith(
			expect.objectContaining({ id: "retry-marker" }),
			"Soften the SFX wording",
			fakeEditor,
		);
	});

	it("offers Resolve and Reject decisions on a result with a comparison preview", async () => {
		vi.spyOn(projectStore, "getImageUrl").mockImplementation((imageId: string) => `https://cdn.test/${imageId}`);
		const updateStatus = vi.spyOn(projectStore, "updateAiReviewMarkerStatus").mockResolvedValue(undefined);

		projectStore.__setProjectForTesting(project([
			marker({
				id: "decide-marker",
				status: "needs_review",
				imageId: "image-1.webp",
				resultImageId: "result-image-444555666",
			}),
		]));
		projectStore.selectAiReviewMarker("decide-marker");

		render(AiReviewMarkersPanel);
		await fireEvent.click(screen.getByText("รายละเอียดผล AI"));

		await fireEvent.click(screen.getByTestId("ai-marker-resolve"));
		expect(updateStatus).toHaveBeenCalledWith("decide-marker", "accepted");

		await fireEvent.click(screen.getByTestId("ai-marker-reject"));
		expect(updateStatus).toHaveBeenCalledWith("decide-marker", "rejected");
	});
});
