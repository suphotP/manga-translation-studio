import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Register the locale dictionaries (addMessages + init) so EditorPathBar's $_(...) keys
// resolve to real strings instead of the raw key. test-setup.ts forces the active locale to th.
import "$lib/i18n";
import EditorPathBar from "$lib/components/EditorPathBar.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { authStore } from "$lib/stores/auth.svelte.ts";
import type { AiReviewMarker, Page, ProjectState, WorkflowTask } from "$lib/types.js";

function signInAs(email: string, id = "user-1"): void {
	authStore.user = {
		id,
		email,
		name: email.split("@")[0],
		role: "editor",
		isActive: true,
	};
}

const now = "2026-05-15T00:00:00.000Z";

function page(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "image-1",
		imageName: "page-1.webp",
		textLayers: [],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function aiReviewMarker(overrides: Partial<AiReviewMarker> = {}): AiReviewMarker {
	return {
		id: "marker-1",
		jobId: "job-1",
		pageIndex: 0,
		imageId: "image-1",
		region: { x: 12, y: 18, w: 120, h: 80 },
		status: "needs_review",
		tier: "sfx-pro",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function workflowTask(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
	return {
		id: "task-1",
		type: "review",
		status: "todo",
		priority: "high",
		pageIndex: 0,
		title: "Review page 1",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		projectId: "project-1",
		name: "Path project",
		createdAt: now,
		currentPage: 0,
		targetLang: "th",
		pages: [page(), page({ imageId: "image-2", imageName: "page-2.webp" })],
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
	window.history.pushState({}, "", "/projects/project-1/pages/1/editor");
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	editorStore.editor = null;
	editorStore.textLayers = [];
	editorStore.imageLayers = [];
	authStore.user = null;
});

afterEach(() => {
	cleanup();
});

describe("EditorPathBar", () => {
	it("separates editor identity, workflow state, and save state", () => {
		projectStore.__setProjectForTesting(project({
			name: "P104 Sales Demo Chapter 104",
		}));
		editorUiStore.openEditor();

		render(EditorPathBar);

		expect(screen.getByText("P104 Sales Demo Chapter 104")).toBeTruthy();
		expect(screen.getByLabelText("ตำแหน่งงานปัจจุบัน").textContent).toContain("TH");
		expect(screen.getByLabelText("ตำแหน่งงานปัจจุบัน").textContent).toContain("หน้า 1/2");
		expect(screen.getByLabelText(/สถานะงานหน้า:/).textContent).toContain("งานหน้า");
		// Topbar redesign: the default base-image chip no longer renders (chip
		// appears only for a real layer selection).
		expect(screen.queryByLabelText(/เลเยอร์ที่เลือก: ภาพฐาน/)).toBeNull();
		expect(screen.getByRole("button", { name: "บันทึก บันทึกแล้ว" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /บันทึก.*พร้อม/ })).toBeNull();
	});

	it("offers a per-page 'submit done' button for the viewer's own open task (#10c)", async () => {
		signInAs("worker@example.com");
		projectStore.__setProjectForTesting(project({
			tasks: [workflowTask({ id: "t-clean", type: "clean", status: "doing", assignee: "worker@example.com", pageIndex: 0 })],
		}));
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openEditor();
		const submit = vi.spyOn(projectStore, "submitTaskToNextStage").mockResolvedValue(undefined);

		render(EditorPathBar);

		const button = screen.getByRole("button", { name: /เสร็จ → ส่งต่อ/ });
		await fireEvent.click(button);
		expect(submit).toHaveBeenCalledWith("t-clean");
		submit.mockRestore();
	});

	it("does not offer the submit button for a task assigned to someone else (#10c)", () => {
		signInAs("worker@example.com");
		projectStore.__setProjectForTesting(project({
			tasks: [workflowTask({ id: "t-clean", type: "clean", status: "doing", assignee: "other@example.com", pageIndex: 0 })],
		}));
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openEditor();

		render(EditorPathBar);

		expect(screen.queryByRole("button", { name: /เสร็จ → ส่งต่อ/ })).toBeNull();
	});

	it("does not offer the submit button in a solo workspace (#10c)", () => {
		signInAs("worker@example.com");
		projectStore.__setProjectForTesting(project({
			tasks: [workflowTask({ id: "t-clean", type: "clean", status: "doing", assignee: "worker@example.com", pageIndex: 0 })],
		}));
		// Default workspaceMode is "solo" — no duty pipeline to hand off into.
		editorUiStore.openEditor();

		render(EditorPathBar);

		expect(screen.queryByRole("button", { name: /เสร็จ → ส่งต่อ/ })).toBeNull();
	});

	it("hides the submit button once the viewer's page task is done (#10c)", () => {
		signInAs("worker@example.com");
		projectStore.__setProjectForTesting(project({
			tasks: [workflowTask({ id: "t-clean", type: "clean", status: "done", assignee: "worker@example.com", pageIndex: 0 })],
		}));
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openEditor();

		render(EditorPathBar);

		expect(screen.queryByRole("button", { name: /เสร็จ → ส่งต่อ/ })).toBeNull();
	});

	it("keeps selected editable layer context in the editor first viewport", () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openEditor();
		editorStore.selectedLayer = {
			id: "intro-text",
			name: "Intro title",
			text: "เปิดฉาก",
			x: 72,
			y: 128,
			w: 180,
			h: 60,
			rotation: 0,
			fontSize: 42,
			alignment: "center",
			index: 0,
		};

		const { unmount } = render(EditorPathBar);

		const selectedText = screen.getByLabelText(/เลเยอร์ที่เลือก: Intro title/);
		expect(selectedText.textContent).toContain("Intro title");
		expect(selectedText.textContent).toContain("72, 128 / 42px");
		unmount();

		editorStore.selectedLayer = null;
		editorStore.selectedImageLayer = {
			id: "ai-result-1",
			imageId: "ai-result-1.webp",
			imageName: "ai-result-1.webp",
			name: "SFX clean result",
			x: 10,
			y: 20,
			w: 240,
			h: 120,
			rotation: 0,
			opacity: 0.75,
			index: 0,
		};

		render(EditorPathBar);

		const selectedImage = screen.getByLabelText(/เลเยอร์ที่เลือก: SFX clean result/);
		expect(selectedImage.textContent).toContain("SFX clean result");
		expect(selectedImage.textContent).toContain("AI / 75%");
	});

	it("hides text styling metadata from the selected-layer receipt when Team Work owns the decision", () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openEditor();
		editorUiStore.setRightPanelMode("work");
		editorStore.selectedLayer = {
			id: "intro-text",
			name: "Intro title",
			text: "เปิดฉาก",
			x: 72,
			y: 128,
			w: 180,
			h: 60,
			rotation: 0,
			fontSize: 42,
			alignment: "center",
			index: 0,
		};

		render(EditorPathBar);

		const selectedText = screen.getByLabelText(/เลเยอร์ที่เลือก: Intro title/);
		expect(selectedText.textContent).toContain("เลือกไว้");
		expect(selectedText.textContent).not.toContain("42px");
		expect(selectedText.textContent).not.toContain("72, 128");
	});

	it("compacts page signal counts without losing the detailed receipt", () => {
		projectStore.__setProjectForTesting(project({
			pages: [page({ textLayers: [{ id: "layer-1", text: "พร้อมรีวิว" } as any] })],
			tasks: [workflowTask()],
			comments: [{
				id: "comment-1",
				pageIndex: 0,
				status: "open",
				body: "check this",
				region: { x: 10, y: 10, w: 120, h: 80 },
				createdAt: now,
				updatedAt: now,
			} as any],
			aiReviewMarkers: [aiReviewMarker()],
		}));
		editorUiStore.openEditor();
		editorStore.textLayers = [{ id: "layer-1", text: "พร้อมรีวิว" } as any];

		render(EditorPathBar);

		const signals = screen.getByLabelText(/สัญญาณของหน้าปัจจุบัน:/);
		expect(signals.textContent).toMatch(/\d+ ต้องเช็ก/);
		expect(signals.textContent).not.toContain("1 เลเยอร์");
		expect(signals.getAttribute("aria-label")).toContain("1 เลเยอร์");
		expect(signals.getAttribute("aria-label")).toContain("งาน");
		expect(signals.getAttribute("aria-label")).toContain("โน้ต");
		expect(signals.getAttribute("aria-label")).toContain("AI");
	});

	it("gives a new image-only editor page first-action ownership before panel details", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openEditor();
		editorStore.hasImage = true;
		editorStore.selectedLayer = null;
		editorStore.selectedImageLayer = null;
		editorUiStore.setRightPanelMode("ai");
		const startTextPlacement = vi.spyOn(editorStore, "startTextPlacement").mockImplementation(() => {});

		render(EditorPathBar);

		const starter = screen.getByLabelText("เริ่มแก้หน้านี้");
		expect(starter.textContent).toContain("เริ่มแก้");
		expect(starter.textContent).toContain("วางข้อความ");
		expect(starter.textContent).toContain("เลเยอร์");
		expect(screen.queryByLabelText(/สถานะงานหน้า:/)).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "วางข้อความแรกบนหน้านี้" }));
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(startTextPlacement).toHaveBeenCalledTimes(1);
	});

	it("gives post-edit pages a direct readiness bridge to the current-page task in the work panel", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [page({ textLayers: [{ id: "layer-1", text: "พร้อมรีวิว" } as any] })],
			tasks: [workflowTask()],
		}));
		editorUiStore.openEditor();
		editorStore.textLayers = [{ id: "layer-1", text: "พร้อมรีวิว" } as any];
		const selectWorkflowTask = vi.spyOn(projectStore, "selectWorkflowTask");

		render(EditorPathBar);

		const bridge = screen.getByRole("button", { name: /เปิดงานหน้านี้:/ });
		expect(bridge.textContent).toContain("เปิดงานหน้านี้");

		await fireEvent.click(bridge);

		// Focus mode was removed: the readiness bridge now opens the task in the
		// editor's contextual Work panel instead of a separate focus view.
		expect(editorUiStore.workspaceView).toBe("editor");
		expect(editorUiStore.rightPanelMode).toBe("work");
		expect(selectWorkflowTask).toHaveBeenCalledWith("task-1");
	});

	it("keeps the path work action passive when the Team work panel already owns the current blocker", () => {
		projectStore.__setProjectForTesting(project({
			pages: [page({ textLayers: [{ id: "layer-1", text: "พร้อมรีวิว" } as any] })],
			tasks: [workflowTask()],
		}));
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openEditor();
		editorUiStore.setRightPanelMode("work");
		editorStore.textLayers = [{ id: "layer-1", text: "พร้อมรีวิว" } as any];

		render(EditorPathBar);

		expect(screen.queryByRole("button", { name: /เปิด Focus หน้านี้:/ })).toBeNull();
		expect(screen.getByLabelText(/แผงงานเปิดอยู่:/).textContent).toContain("แผงงานเปิดอยู่");
	});

	it("makes unsaved editor work save before sending users toward QC or export", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [page({ textLayers: [{ id: "layer-1", text: "พร้อมส่งต่อ" } as any] })],
		}));
		editorUiStore.openEditor();
		editorStore.textLayers = [{ id: "layer-1", text: "พร้อมส่งต่อ" } as any];
		projectStore.saveSyncStatus = "unsaved";
		const saveCurrentPage = vi.spyOn(projectStore, "saveCurrentPage").mockResolvedValue(undefined);

		render(EditorPathBar);

		await fireEvent.click(screen.getByRole("button", { name: /บันทึกก่อนส่งต่อ:/ }));

		expect(saveCurrentPage).toHaveBeenCalledWith(editorStore.editor);
		expect(editorUiStore.workspaceView).toBe("editor");
		expect(screen.queryByRole("button", { name: "บันทึก ยังไม่บันทึก" })).toBeNull();
		expect(screen.getByText("ยังไม่บันทึก")).toBeTruthy();
	});

	it("routes ready edited pages to the Pages export gate instead of hiding export in tools", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [page({ textLayers: [{ id: "layer-1", text: "พร้อม Export" } as any] })],
		}));
		editorUiStore.openEditor();
		editorStore.textLayers = [{ id: "layer-1", text: "พร้อม Export" } as any];

		render(EditorPathBar);

		await fireEvent.click(screen.getByRole("button", { name: /เช็ก Export:/ }));

		expect(editorUiStore.workspaceView).toBe("pages");
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/pages"));
	});

	it("renders current and edge page strip states without disabled no-op buttons", () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openEditor();

		const { container } = render(EditorPathBar);

		const strip = screen.getByLabelText("หน้าข้างเคียงในตอน");
		expect(strip.textContent).toContain("P1");
		expect(strip.textContent).toContain("P2");
		expect(screen.getByLabelText("กำลังแก้หน้า 1, รอรีวิวผล").getAttribute("aria-current")).toBe("page");
		expect(screen.queryByLabelText("อยู่หน้าแรกแล้ว")).toBeNull();
		expect(screen.getByRole("button", { name: /เปิดหน้า 2/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: "หน้าถัดไปจาก path" })).toBeTruthy();
		expect(Array.from(container.querySelectorAll(".page-strip button:disabled"))).toHaveLength(0);
	});

	it("shows localized page recovery copy instead of raw workflow labels", () => {
		projectStore.__setProjectForTesting(project());
		projectStore.assetLoadErrors = {
			0: {
				pageIndex: 0,
				imageId: "image-1",
				imageName: "page-1.webp",
				message: "Image returned 404",
			},
		};
		editorUiStore.openEditor();

		render(EditorPathBar);

		// Status renders in both the pill and the path-next line (which replaced
		// the coaching copy) — status-not-coaching means it appears MORE than once.
		expect(screen.getAllByText("ติดปัญหา").length).toBeGreaterThanOrEqual(1);
		expect(screen.queryByText("กู้หรือเปลี่ยนรูปหน้า")).toBeNull();
		expect(screen.queryByText("Blocked")).toBeNull();
		expect(screen.queryByText("Relink or restore page image")).toBeNull();
	});

	it("opens the team board from the editor tools menu when the chapter has open work", async () => {
		projectStore.__setProjectForTesting(project({
			aiReviewMarkers: [aiReviewMarker({ id: "marker-1" })],
		}));
		editorUiStore.openEditor();

		render(EditorPathBar);

		await fireEvent.click(screen.getByRole("button", { name: "เครื่องมือ" }));
		await fireEvent.click(screen.getByRole("menuitem", { name: /เปิดบอร์ดทีม\s+งานถัดไปของตอน/ }));

		// Focus mode was removed: the tools menu now routes to the team Work Board.
		expect(editorUiStore.workspaceView).toBe("work");
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/work"));
	});

	it("shows library entry context and returns to the exact library chapter", async () => {
		projectStore.__setProjectForTesting(project({
			name: "Alpha Chapter 1",
			targetLang: "th",
		}));
		editorUiStore.setWorkspaceTitleKey("alpha");
		editorUiStore.openEditor({
			source: "library",
			projectId: "project-1",
			titleKey: "alpha",
			title: "Alpha",
			chapterLabel: "ตอน 1",
			language: "th",
			reason: "ตรวจหน้าที่รอ",
		});

		render(EditorPathBar);

		const entry = screen.getByLabelText("บริบทจากคลังงาน");
		// Topbar redesign: one compact return button; chapter/lang/reason ride its title.
		const returnBtn = within(entry).getByRole("button");
		expect(returnBtn.getAttribute("title")).toContain("ตอน 1");
		expect(returnBtn.getAttribute("title")).toContain("TH / ตรวจหน้าที่รอ");
		expect(screen.getByLabelText("ตำแหน่งงานปัจจุบัน").textContent).toContain("จากคลังงาน");

		await fireEvent.click(screen.getByRole("button", { name: "กลับตอนนี้" }));

		expect(editorUiStore.workspaceView).toBe("library");
		expect(editorUiStore.workspaceTitleKey).toBe("alpha");
		expect(editorUiStore.workspaceLanguageKey).toBe("th");
		await waitFor(() => expect(window.location.pathname).toBe("/library/alpha/chapters/project-1"));
	});

	it("hides stale library entry context after a different project is open", () => {
		projectStore.__setProjectForTesting(project({
			projectId: "project-2",
		}));
		editorUiStore.openEditor({
			source: "library",
			projectId: "project-1",
			titleKey: "alpha",
			title: "Alpha",
			chapterLabel: "ตอน 1",
			language: "th",
			reason: "ตรวจหน้าที่รอ",
		});

		render(EditorPathBar);

		expect(screen.queryByLabelText("บริบทจากคลังงาน")).toBeNull();
	});

	it("keeps save retry in the editor-local path bar", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openEditor();
		projectStore.saveSyncStatus = "error";
		projectStore.saveErrorMessage = "disk is full";
		const saveCurrentPage = vi.spyOn(projectStore, "saveCurrentPage").mockResolvedValue(undefined);

		render(EditorPathBar);

		const retrySave = screen.getByRole("button", { name: /ลองบันทึกก่อนส่งต่อ: บันทึกล้มเหลว/ });
		expect(retrySave.className).toContain("blocked");
		expect(screen.queryByRole("button", { name: /ลองบันทึก\s+ล้มเหลว/ })).toBeNull();

		await fireEvent.click(retrySave);

		expect(saveCurrentPage).toHaveBeenCalledWith(editorStore.editor);
	});

	it("routes conflict recovery to reload instead of retrying save from the path bar", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openEditor();
		projectStore.saveSyncStatus = "error";
		projectStore.saveErrorKind = "conflict";
		projectStore.saveErrorMessage = "โปรเจกต์เปลี่ยนจากที่อื่น โหลดใหม่ก่อนบันทึก";
		await Promise.resolve();

		render(EditorPathBar);

		const reload = screen.getByRole("button", { name: /โหลดใหม่ก่อนส่งต่อ: ชนกัน/ });
		expect(reload.textContent).toContain("โหลดใหม่ก่อนส่งต่อ");
		expect(screen.queryByRole("button", { name: /โหลดใหม่\s+ชนกัน/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /ลองบันทึก\s+ล้มเหลว/ })).toBeNull();
	});

	it("shows a passive export receipt when a save conflict is unresolved", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openEditor();
		projectStore.saveSyncStatus = "error";
		projectStore.saveErrorKind = "conflict";
		projectStore.saveErrorMessage = "โปรเจกต์เปลี่ยนจากที่อื่น โหลดใหม่ก่อนบันทึก";
		const exportPage = vi.spyOn(projectStore, "exportPage").mockResolvedValue(undefined);

		render(EditorPathBar);

		await fireEvent.click(screen.getByRole("button", { name: "เครื่องมือ" }));

		expect(screen.getByRole("menuitem", { name: /Export ถูกบล็อกเพราะบันทึกชนกัน/ })).toBeTruthy();
		expect(screen.queryByRole("menuitem", { name: /ส่งออก PNG\s+หน้าปัจจุบัน/ })).toBeNull();
		expect(exportPage).not.toHaveBeenCalled();
	});

	it("keeps page export and import inside the editor-local tools menu", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openEditor();
		const exportPage = vi.spyOn(projectStore, "exportPage").mockResolvedValue(undefined);
		const importJson = vi.spyOn(projectStore, "importJson").mockResolvedValue(undefined);

		render(EditorPathBar);

		const toolsButton = screen.getByRole("button", { name: "เครื่องมือ" });
		await fireEvent.click(toolsButton);

		await fireEvent.click(screen.getByRole("menuitem", { name: /Export PNG\s+หน้าปัจจุบัน/ }));
		expect(exportPage).toHaveBeenCalledWith(editorStore.editor);

		await fireEvent.click(toolsButton);
		await fireEvent.click(screen.getByRole("menuitem", { name: /Import JSON\s+OCR \/ layout หน้า/ }));
		expect(importJson).toHaveBeenCalledWith(editorStore.editor);

		await fireEvent.click(toolsButton);
		expect(screen.getByRole("menuitem", { name: /เปิดหน้าในตอน\s+แผนที่หน้าและ Export/ })).toBeTruthy();
	});
});
