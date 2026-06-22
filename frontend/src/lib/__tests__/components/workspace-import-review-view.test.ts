import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import WorkspaceImportReviewView from "$lib/components/WorkspaceImportReviewView.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { ProjectState } from "$lib/types.js";

const now = "2026-05-14T00:00:00.000Z";

function project(): ProjectState {
	return {
		projectId: "project-1",
		name: "Alpha Chapter 1",
		createdAt: now,
		currentPage: 0,
		targetLang: "en",
		pages: [
			{
				imageId: "image-1",
				imageName: "page-1.png",
				textLayers: [{ id: "layer-1", text: "Done" } as any],
				pendingAiJobs: [],
				coverRect: null,
			},
			{
				imageId: "image-2",
				imageName: "page-2.png",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			},
		],
		comments: [
			{
				id: "comment-1",
				pageIndex: 1,
				body: "Check redraw edge",
				author: "Reviewer",
				status: "open",
				createdAt: now,
				updatedAt: now,
			},
		],
		tasks: [
			{
				id: "task-1",
				type: "review",
				status: "review",
				priority: "high",
				pageIndex: 1,
				title: "Review page 2",
				createdAt: now,
				updatedAt: now,
			},
		],
	};
}

beforeEach(() => {
	vi.restoreAllMocks();
	window.history.pushState({}, "", "/projects/project-1/import");
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	editorStore.textLayers = [];
	editorStore.imageLayers = [];
	editorStore.editor = null;
	editorStore.hasImage = false;
});

describe("WorkspaceImportReviewView", () => {
	it("renders import readiness, mapping guidance, and target pages", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openImportReview();
		editorStore.textLayers = [{ id: "layer-1", text: "Done" } as any];

		render(WorkspaceImportReviewView);

		expect(screen.getByRole("region", { name: "Import ข้อความ" })).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Alpha Chapter 1" })).toBeTruthy();
		expect(screen.getByText(/EN\s*·\s*2\s*หน้า\s*·\s*1\s*หน้ามีเลเยอร์ข้อความ/i)).toBeTruthy();
		expect(screen.getByRole("region", { name: "คำสั่งหลัก Import" })).toBeTruthy();
		expect(screen.getByText("Import JSON แล้วตรวจหน้าที่ได้ข้อความ")).toBeTruthy();
		expect(screen.getByLabelText("ขอบเขตที่จะ Import").textContent).toBe("EN / 2 หน้า / เลเยอร์ดราฟต์");
		expect(screen.getByText("ตรวจว่าข้อความตรงกับหน้าถูกต้อง")).toBeTruthy();
		expect(screen.getByRole("link", { name: "คู่มือ JSON" }).getAttribute("href")).toBe("/tools/import-json");
		expect(screen.getByRole("button", { name: "จับคู่รูป" })).toBeTruthy();
		const targets = screen.getByRole("region", { name: "หน้าเป้าหมาย Import" });
		expect(within(targets).getByRole("button", { name: "ตรวจหน้าที่มีข้อความแรก" })).toBeTruthy();
		expect(within(targets).getByRole("button", { name: "ตรวจหน้า 1" })).toBeTruthy();
		expect(within(targets).getByRole("button", { name: "ตรวจหน้า 2" })).toBeTruthy();
		expect(within(targets).queryByRole("button", { name: "ตรวจหน้านี้" })).toBeNull();
		expect(within(targets).getByText("หน้า 1")).toBeTruthy();
		expect(within(targets).getByText("หน้า 2")).toBeTruthy();
		expect(within(targets).getByText("มีเลเยอร์ดราฟต์แล้ว เปิดตรวจตำแหน่งและจัดบรรทัด")).toBeTruthy();
		expect(within(targets).getByText("รอ Import JSON หรือเว้นไว้ถ้ายังไม่ใช้หน้านี้")).toBeTruthy();
		expect(within(targets).queryByText("ตรวจตำแหน่งข้อความ")).toBeNull();
		expect(within(targets).queryByText("page-1")).toBeNull();
		expect(within(targets).queryByText("page-2")).toBeNull();
		expect(within(targets).queryByText("ตรวจ mapping ข้อความ")).toBeNull();
		expect(within(targets).getAllByText(/1 เลเยอร์ข้อความ/i).length).toBeGreaterThan(0);
		expect(within(targets).getByText(/1 โน้ต \/ 1 งาน/i)).toBeTruthy();
	});

	it("names the current page target when there are no imported draft layers yet", () => {
		const emptyDraftProject = project();
		emptyDraftProject.currentPage = 1;
		emptyDraftProject.pages = emptyDraftProject.pages.map((page) => ({ ...page, textLayers: [] }));
		projectStore.__setProjectForTesting(emptyDraftProject);
		editorUiStore.openImportReview();
		editorStore.textLayers = [];

		render(WorkspaceImportReviewView);

		const targets = screen.getByRole("region", { name: "หน้าเป้าหมาย Import" });
		expect(within(targets).getByRole("button", { name: "เปิดหน้า 2" })).toBeTruthy();
		expect(within(targets).queryByRole("button", { name: "เปิดหน้าแก้ปัจจุบัน" })).toBeNull();
	});

	it("uses a review receipt before a chapter is open", () => {
		editorUiStore.openImportReview();

		render(WorkspaceImportReviewView);

		const targets = screen.getByRole("region", { name: "หน้าเป้าหมาย Import" });
		expect(within(targets).getByText("เปิดตอนก่อนตรวจหน้า")).toBeTruthy();
		expect(within(targets).queryByText("เปิดตอนก่อนเปิดหน้าแก้")).toBeNull();
	});

	it("surfaces image asset recovery directly in the target list", () => {
		projectStore.__setProjectForTesting(project());
		projectStore.assetLoadErrors = {
			1: {
				pageIndex: 1,
				imageId: "image-2",
				imageName: "page-2.png",
				message: "Image returned 404",
			},
		};
		editorUiStore.openImportReview();

		render(WorkspaceImportReviewView);

		const targets = screen.getByRole("region", { name: "หน้าเป้าหมาย Import" });
		expect(within(targets).getAllByText("โหลดรูปไม่สำเร็จ").length).toBeGreaterThan(0);
		expect(within(targets).getByText(/รูปโหลดไม่สำเร็จ/)).toBeTruthy();
		expect(within(targets).queryByText("Failed")).toBeNull();
		expect(within(targets).queryByText(/image failed/i)).toBeNull();
		expect(within(targets).getByRole("button", { name: "กู้รูป" })).toBeTruthy();
	});

	it("does not show image recovery for released page assets in the current project inventory", () => {
		projectStore.__setProjectForTesting(project());
		projectStore.imageAssetsProjectId = "project-1";
		projectStore.imageAssets = [
			{
				assetId: "image-1",
				imageId: "image-1",
				originalName: "page-1.png",
				storageStatus: "released",
				moderationStatus: "passed",
			},
			{
				assetId: "image-2",
				imageId: "image-2",
				originalName: "page-2.png",
				storageStatus: "released",
				moderationStatus: "passed",
			},
		] as any;
		editorUiStore.openImportReview();

		render(WorkspaceImportReviewView);

		const targets = screen.getByRole("region", { name: "หน้าเป้าหมาย Import" });
		expect(within(targets).queryByText(/image missing/i)).toBeNull();
		expect(within(targets).queryByText("รูปหาย")).toBeNull();
		expect(within(targets).queryByRole("button", { name: "กู้รูป" })).toBeNull();
	});

	it("counts persisted current-page text before the editor image loads", () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openImportReview();
		editorStore.textLayers = [];
		editorStore.hasImage = false;

		render(WorkspaceImportReviewView);

		expect(screen.getByText(/EN\s*·\s*2\s*หน้า\s*·\s*1\s*หน้ามีเลเยอร์ข้อความ/i)).toBeTruthy();
		expect(screen.getByLabelText("สรุปความพร้อม Import").textContent).toMatch(/เลเยอร์ข้อความ\s*1/i);
	});

	it("opens a target page into the canvas route", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openImportReview();
		vi.spyOn(projectStore, "goToPage").mockResolvedValue(true);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspaceImportReviewView);

		const targets = screen.getByRole("region", { name: "หน้าเป้าหมาย Import" });
		await fireEvent.click(within(targets).getByRole("button", { name: "ตรวจหน้า 2" }));

		expect(projectStore.goToPage).toHaveBeenCalledWith(1, null);
		expect(editorStore.refreshTextLayers).toHaveBeenCalled();
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/pages/2/editor"));
	});

	it("copies the import review link from the primary action", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openImportReview();
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});

		render(WorkspaceImportReviewView);

		const primaryAction = screen.getByRole("region", { name: "คำสั่งหลัก Import" });
		await fireEvent.click(within(primaryAction).getByRole("button", { name: "คัดลอกลิงก์" }));

		expect(writeText).toHaveBeenCalledWith("http://localhost:3000/projects/project-1/import");
		expect(projectStore.statusMsg).toBe("คัดลอกลิงก์ Import แล้ว");
		expect(window.location.pathname).toBe("/projects/project-1/import");
	});

	it("opens the existing JSON import picker from the review surface", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openImportReview();
		const importJson = vi.spyOn(projectStore, "importJson").mockResolvedValue();

		render(WorkspaceImportReviewView);

		const primaryAction = screen.getByRole("region", { name: "คำสั่งหลัก Import" });
		await fireEvent.click(within(primaryAction).getByRole("button", { name: "Import JSON" }));

		expect(importJson).toHaveBeenCalledWith(undefined);
	});

	it("does not pass a blank editor from the import surface into JSON import", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openImportReview();
		editorStore.editor = { getAllTextLayers: vi.fn(() => []) } as any;
		editorStore.hasImage = false;
		const importJson = vi.spyOn(projectStore, "importJson").mockResolvedValue();

		render(WorkspaceImportReviewView);

		const primaryAction = screen.getByRole("region", { name: "คำสั่งหลัก Import" });
		await fireEvent.click(within(primaryAction).getByRole("button", { name: "Import JSON" }));

		expect(importJson).toHaveBeenCalledWith(undefined);
	});
});
