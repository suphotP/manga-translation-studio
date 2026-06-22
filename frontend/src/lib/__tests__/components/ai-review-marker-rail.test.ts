import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import AiReviewMarkerRail from "$lib/components/AiReviewMarkerRail.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { AiReviewMarker, Page, ProjectState } from "$lib/types.js";

const now = "2026-05-14T00:00:00.000Z";

function marker(overrides: Partial<AiReviewMarker> = {}): AiReviewMarker {
	return {
		id: "marker-1",
		jobId: "job-1",
		pageIndex: 0,
		imageId: "image-1.webp",
		region: { x: 10, y: 20, w: 120, h: 80 },
		status: "needs_review",
		tier: "clean-pro",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function page(): Page {
	return {
		imageId: "image-1.webp",
		imageName: "image-1.webp",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
	};
}

function project(markers: AiReviewMarker[]): ProjectState {
	return {
		projectId: "project-1",
		name: "AI marker rail test",
		createdAt: now,
		pages: [page()],
		currentPage: 0,
		targetLang: "en",
		tasks: [],
		activityLog: [],
		comments: [],
		aiReviewMarkers: markers,
		reviewDecisions: [],
		workspaceMessages: [],
		versionReviewRequests: [],
	};
}

beforeEach(() => {
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	editorStore.editor = null;
	editorStore.selectedImageLayer = null;
});

describe("AiReviewMarkerRail", () => {
	it("shows only active AI markers plus the selected resolved marker", () => {
		projectStore.__setProjectForTesting(project([
			marker({ id: "needs-review", status: "needs_review" }),
			marker({ id: "processing", jobId: "job-2", status: "processing", region: { x: 20, y: 30, w: 80, h: 80 } }),
			marker({ id: "failed", jobId: "job-3", status: "failed", region: { x: 30, y: 40, w: 80, h: 80 } }),
			marker({ id: "accepted", jobId: "job-4", status: "accepted", region: { x: 40, y: 50, w: 80, h: 80 } }),
		]));
		projectStore.selectAiReviewMarker("accepted");

		render(AiReviewMarkerRail);

		expect(screen.getByRole("region", { name: "ผล AI บนหน้านี้" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "เปิดผล AI P1 Clean Pro รอรีวิว รอผล พื้นที่ 10,20 / 120x80" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "เปิดผล AI P1 Clean Pro กำลังรัน กำลังทำ พื้นที่ 20,30 / 80x80" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "เปิดผล AI P1 Clean Pro รันพลาด ต้องแก้ พื้นที่ 30,40 / 80x80" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "เปิดผล AI P1 Clean Pro ผ่านรีวิว รอผล พื้นที่ 40,50 / 80x80" })).toBeTruthy();
	});

	it("caps visible pins and opens the AI inspector", async () => {
		const focusImageRegion = vi.fn(() => true);
		editorStore.editor = { focusImageRegion } as any;
		const markers = Array.from({ length: 8 }, (_, index) => marker({
			id: `marker-${index}`,
			jobId: `job-${index}`,
			status: index === 7 ? "accepted" : "needs_review",
			region: { x: 10 + index, y: 20 + index, w: 80, h: 80 },
		}));
		projectStore.__setProjectForTesting(project(markers));
		projectStore.selectAiReviewMarker("marker-7");
		editorUiStore.setRightPanelMode("layers");

		render(AiReviewMarkerRail);

		expect(screen.getAllByRole("button")).toHaveLength(7);
		const overflow = screen.getByRole("button", { name: "แสดงผล AI อีก 2 รายการ" });
		expect(overflow.textContent).toContain("+2 เพิ่มเติม");
		expect(screen.getByRole("button", { name: "เปิดผล AI P1 Clean Pro ผ่านรีวิว รอผล พื้นที่ 17,27 / 80x80" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "เปิดผล AI P1 Clean Pro รอรีวิว รอผล พื้นที่ 10,20 / 80x80" }));

		expect(projectStore.selectedAiReviewMarkerId).toBe("marker-0");
		expect(editorUiStore.rightPanelMode).toBe("ai");
		expect(focusImageRegion).toHaveBeenCalledWith({ x: 10, y: 20, w: 80, h: 80 });

		await fireEvent.click(overflow);
		expect(screen.getAllByRole("button")).toHaveLength(8);
		expect(screen.getByRole("button", { name: "ย่อรายการผล AI" })).toBeTruthy();
	});

	it("labels accepted ready results as not placed until the editable layer exists", () => {
		const accepted = marker({
			id: "accepted-ready",
			status: "accepted",
			resultImageId: "result-image.webp",
		});
		projectStore.__setProjectForTesting(project([accepted]));
		projectStore.selectAiReviewMarker("accepted-ready");

		render(AiReviewMarkerRail);

		const button = screen.getByRole("button", {
			name: "เปิดผล AI P1 Clean Pro ผ่านรีวิว ยังไม่วาง พื้นที่ 10,20 / 120x80",
		});
		expect(button.textContent).toContain("รอวาง");
		expect(button.textContent).not.toContain("วาง Layer");
		expect(button.textContent).not.toContain("ผลพร้อม");
		expect(button.textContent).not.toContain("ผ่านผ่าน");
	});

	it("keeps the rail anchored to a selected applied AI layer even when the review marker is not explicitly selected", () => {
		const applied = marker({
			id: "applied-ready",
			status: "applied",
			resultImageId: "result-image.webp",
		});
		const staleReview = marker({
			id: "stale-review",
			jobId: "job-stale",
			status: "needs_review",
			region: { x: 60, y: 70, w: 90, h: 80 },
		});
		const state = project([staleReview, applied]);
		state.pages[0].imageLayers = [{
			id: "ai-result-applied-ready",
			imageId: "result-image.webp",
			imageName: "result-image.webp",
			originalName: "ผล AI หน้า 1",
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

		render(AiReviewMarkerRail);

		const button = screen.getByRole("button", {
			name: "เปิดผล AI P1 Clean Pro วางแล้ว พื้นที่ 10,20 / 120x80",
		});
		expect(button.classList.contains("selected")).toBe(true);
		expect(button.textContent).toContain("วางแล้ว");
		expect(screen.getByRole("button", {
			name: "เปิดผล AI P1 Clean Pro รอรีวิว รอผล พื้นที่ 60,70 / 90x80",
		}).classList.contains("selected")).toBe(false);
	});

	it("labels result-ready review pins as a direct canvas jump instead of a vague or decision action", () => {
		projectStore.__setProjectForTesting(project([
			marker({ id: "result-ready", resultImageId: "result-image.webp" }),
		]));

		render(AiReviewMarkerRail);

		const button = screen.getByRole("button", {
			name: "เปิดผล AI P1 Clean Pro รอรีวิว ผลพร้อม พื้นที่ 10,20 / 120x80",
		});
		expect(button.textContent).toContain("AI 1");
		expect(button.textContent).toContain("ดูบนภาพ");
		expect(button.textContent).not.toContain("ตัดสิน");
		expect(button.textContent).not.toContain("ดูผล");
		expect(button.getAttribute("title")).toBe("เปิดแผงงานเพื่อรีวิวผล AI: P1 · AI 1 Clean Pro รอรีวิว ผลพร้อม");
	});

	it("opens Layers instead of Work for accepted unplaced placement pins", async () => {
		const focusImageRegion = vi.fn(() => true);
		editorStore.editor = { focusImageRegion } as any;
		const accepted = marker({
			id: "accepted-ready",
			status: "accepted",
			resultImageId: "result-image.webp",
		});
		projectStore.__setProjectForTesting(project([accepted]));
		editorUiStore.setRightPanelMode("work");

		render(AiReviewMarkerRail);
		await fireEvent.click(screen.getByRole("button", {
			name: "เปิดผล AI P1 Clean Pro ผ่านรีวิว ยังไม่วาง พื้นที่ 10,20 / 120x80",
		}));

		expect(projectStore.selectedAiReviewMarkerId).toBe("accepted-ready");
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(focusImageRegion).toHaveBeenCalledWith({ x: 10, y: 20, w: 120, h: 80 });
	});

	it("shows accepted unplaced results even before the marker is selected", () => {
		const accepted = marker({
			id: "accepted-ready",
			status: "accepted",
			resultImageId: "result-image.webp",
		});
		projectStore.__setProjectForTesting(project([accepted]));

		render(AiReviewMarkerRail);

		expect(screen.getByRole("button", {
			name: "เปิดผล AI P1 Clean Pro ผ่านรีวิว ยังไม่วาง พื้นที่ 10,20 / 120x80",
		})).toBeTruthy();
		expect(screen.getByText("รอวาง")).toBeTruthy();
		expect(screen.queryByText("วาง Layer")).toBeNull();
	});

	it("opens the generated layer controls for applied AI results", async () => {
		const focusImageRegion = vi.fn(() => true);
		const selectImageLayer = vi.fn();
		editorStore.editor = { focusImageRegion, selectImageLayer } as any;
		const applied = marker({
			id: "applied-marker",
			status: "applied",
			resultImageId: "result-image.webp",
		});
		const state = project([applied]);
		state.pages[0].imageLayers = [{
			id: "ai-result-applied-marker",
			imageId: "result-image.webp",
			imageName: "result-image.webp",
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
		projectStore.selectAiReviewMarker("applied-marker");

		render(AiReviewMarkerRail);
		const button = screen.getByRole("button", {
			name: "เปิดผล AI P1 Clean Pro วางแล้ว พื้นที่ 10,20 / 120x80",
		});
		expect(button.textContent).toContain("เปิดเลเยอร์ AI");

		await fireEvent.click(button);

		expect(selectImageLayer).toHaveBeenCalledWith("ai-result-applied-marker");
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.imageInspectorFocusLayerId).toBe("ai-result-applied-marker");
	});

	it("marks applied AI results as missing when the generated layer is gone", () => {
		const applied = marker({
			id: "applied-missing-layer",
			status: "applied",
			resultImageId: "result-image.webp",
		});
		projectStore.__setProjectForTesting(project([applied]));
		projectStore.selectAiReviewMarker("applied-missing-layer");

		render(AiReviewMarkerRail);

		const button = screen.getByRole("button", {
			name: "เปิดผล AI P1 Clean Pro วางแล้ว เลเยอร์หาย พื้นที่ 10,20 / 120x80",
		});
		expect(button.textContent).toContain("เลเยอร์หาย");
		expect(button.textContent).toContain("กู้เลเยอร์ AI");
	});

	it("keeps compact viewport pins text-short while preserving accessible detail", async () => {
		const originalMatchMedia = window.matchMedia;
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			writable: true,
			value: vi.fn().mockImplementation(() => ({
				matches: true,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			})),
		});
		projectStore.__setProjectForTesting(project([marker()]));

		try {
			render(AiReviewMarkerRail);
			await Promise.resolve();

			const rail = screen.getByRole("region", { name: "ผล AI บนหน้านี้" });
			const pin = screen.getByRole("button", { name: "เปิดผล AI P1 Clean Pro รอรีวิว รอผล พื้นที่ 10,20 / 120x80" });
			expect(pin.textContent).toContain("P1");
			expect(pin.textContent).toContain("AI 1");
			expect(pin.textContent).toContain("รีวิว");
			expect(pin.textContent?.trim()).not.toBe("ดู");
			expect(rail.textContent).not.toContain("พื้นที่ 10,20");
		} finally {
			Object.defineProperty(window, "matchMedia", {
				configurable: true,
				writable: true,
				value: originalMatchMedia,
			});
		}
	});

	it("keeps compact same-page result states readable without long action labels", async () => {
		const originalMatchMedia = window.matchMedia;
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			writable: true,
			value: vi.fn().mockImplementation(() => ({
				matches: true,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			})),
		});
		const review = marker({ id: "review-ready", resultImageId: "review-result.webp" });
		const accepted = marker({
			id: "accepted-ready",
			jobId: "job-accepted",
			status: "accepted",
			resultImageId: "accepted-result.webp",
		});
		const applied = marker({
			id: "applied-ready",
			jobId: "job-applied",
			status: "applied",
			resultImageId: "applied-result.webp",
		});
		const state = project([review, accepted, applied]);
		state.pages[0].imageLayers = [{
			id: "ai-result-applied-ready",
			imageId: "applied-result.webp",
			imageName: "applied-result.webp",
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

		try {
			render(AiReviewMarkerRail);
			await Promise.resolve();

			const reviewPin = screen.getByRole("button", { name: "เปิดผล AI P1 Clean Pro รอรีวิว ผลพร้อม พื้นที่ 10,20 / 120x80" });
			const acceptedPin = screen.getByRole("button", { name: "เปิดผล AI P1 Clean Pro ผ่านรีวิว ยังไม่วาง พื้นที่ 10,20 / 120x80" });
			const appliedPin = screen.getByRole("button", { name: "เปิดผล AI P1 Clean Pro วางแล้ว พื้นที่ 10,20 / 120x80" });
			expect(reviewPin.textContent).toMatch(/AI \d/);
			expect(reviewPin.textContent).toContain("รอรีวิว");
			expect(acceptedPin.textContent).toMatch(/AI \d/);
			expect(acceptedPin.textContent).toContain("รอวาง");
			expect(appliedPin.textContent).toMatch(/AI \d/);
			expect(appliedPin.textContent).toContain("วางแล้ว");
			expect(appliedPin.textContent).not.toContain("เปิดเลเยอร์ AI");
		} finally {
			Object.defineProperty(window, "matchMedia", {
				configurable: true,
				writable: true,
				value: originalMatchMedia,
			});
		}
	});

	it("uses compact locator copy when the editor inspector is already open", () => {
		projectStore.__setProjectForTesting(project([
			marker({ id: "review-ready", resultImageId: "review-result.webp" }),
		]));
		editorUiStore.openEditor(null);
		editorUiStore.setRightPanelMode("layers");

		render(AiReviewMarkerRail);

		const rail = screen.getByRole("region", { name: "ผล AI บนหน้านี้" });
		const button = screen.getByRole("button", {
			name: "เปิดผล AI P1 Clean Pro รอรีวิว ผลพร้อม พื้นที่ 10,20 / 120x80",
		});
		expect(rail.classList.contains("inspector-compact")).toBe(true);
		expect(button.textContent).toContain("AI 1");
		expect(button.textContent).toContain("P1");
		expect(button.textContent).toContain("รอรีวิว");
		expect(button.textContent).not.toContain("ดูบนภาพ");
	});

	it("uses a quieter rail mode when the AI panel already shows page results", async () => {
		const originalMatchMedia = window.matchMedia;
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			writable: true,
			value: vi.fn().mockImplementation(() => ({
				matches: true,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			})),
		});
		projectStore.__setProjectForTesting(project([
			marker({ id: "review-ready", resultImageId: "review-result.webp" }),
			marker({
				id: "accepted-ready",
				jobId: "job-accepted",
				status: "accepted",
				resultImageId: "accepted-result.webp",
			}),
		]));
		editorUiStore.setRightPanelMode("ai");

		try {
			render(AiReviewMarkerRail);
			await Promise.resolve();

			const rail = screen.getByRole("region", { name: "ตัวชี้พื้นที่ผล AI บนภาพ" });
			expect(rail.classList.contains("panel-result-mode")).toBe(true);
			expect(screen.getByRole("button", { name: "เปิดผล AI P1 Clean Pro รอรีวิว ผลพร้อม พื้นที่ 10,20 / 120x80" })).toBeTruthy();
			expect(screen.getByRole("button", { name: "เปิดผล AI P1 Clean Pro ผ่านรีวิว ยังไม่วาง พื้นที่ 10,20 / 120x80" })).toBeTruthy();
		} finally {
			Object.defineProperty(window, "matchMedia", {
				configurable: true,
				writable: true,
				value: originalMatchMedia,
			});
		}
	});
});
