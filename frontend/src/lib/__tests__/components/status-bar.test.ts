import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import "$lib/i18n";
import StatusBar from "$lib/components/StatusBar.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { editLeaseStore } from "$lib/stores/edit-lease.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { Page, ProjectState } from "$lib/types.js";

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
		name: "Save status test",
		createdAt: "2026-05-14T00:00:00.000Z",
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
	editorUiStore.__resetForTesting();
	editLeaseStore.__resetForTesting();
	editorStore.editor = { id: "editor" };
	vi.restoreAllMocks();
});

describe("StatusBar", () => {
	it("uses workspace-specific idle copy when no project is open", () => {
		editorUiStore.openLibrary();

		render(StatusBar);

		expect(screen.getByText("คลังงานพร้อมเลือกตอน")).toBeTruthy();
		expect(screen.queryByText("เปิดโฟลเดอร์เพื่อเริ่มงาน")).toBeNull();
	});

	it("shows actionable save failure detail and retries the current page save", async () => {
		projectStore.__setProjectForTesting(project());
		projectStore.saveSyncStatus = "error";
		projectStore.saveErrorMessage = "disk is full";
		projectStore.saveErrorKind = "generic";
		const saveCurrentPage = vi.spyOn(projectStore, "saveCurrentPage").mockResolvedValue(undefined);

		render(StatusBar);

		expect(screen.getByText("บันทึกไม่สำเร็จ: disk is full")).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "ลองบันทึกอีกครั้ง" }));
		expect(saveCurrentPage).toHaveBeenCalledWith(editorStore.editor);
	});

	it("surfaces lock-service fallback as a visible solo-edit chip", () => {
		projectStore.__setProjectForTesting(project());
		editLeaseStore.__setStateForTesting("unavailable");

		render(StatusBar);

		const chip = screen.getByText("โหมดแก้คนเดียว / Lock ใช้ไม่ได้");
		expect(chip).toBeTruthy();
		expect(chip.getAttribute("title")).toContain("ระบบล็อกหน้าไม่พร้อม");
	});

	it("routes image-layer brush save failures back to Layers instead of retrying blindly", async () => {
		projectStore.__setProjectForTesting(project());
		projectStore.saveSyncStatus = "error";
		projectStore.saveErrorMessage = "รอยแปรงยังไม่ถูกบันทึก (quota)";
		projectStore.saveErrorKind = "brush";
		editorStore.brushTarget = {
			kind: "image-layer",
			label: "เลเยอร์รูปแก้ไข",
			labelCode: "imageLayer",
			title: "Clean target",
			titleCode: null,
			detail: "ลบเฉพาะเลเยอร์",
			scope: "แก้เฉพาะเลเยอร์นี้",
			impact: "มีผลตอนบันทึก",
			eraseLabelCode: "layerErase",
			restoreLabelCode: "layerRestore",
			restoreHint: "กู้คืนจากต้นฉบับ",
			canBrush: true,
			canRestore: true,
			canClearMask: false,
			tone: "ready",
		};
		const saveCurrentPage = vi.spyOn(projectStore, "saveCurrentPage").mockResolvedValue(undefined);
		const setTool = vi.spyOn(editorStore, "setTool").mockImplementation((tool: any) => {
			editorStore.currentTool = tool;
		});

		render(StatusBar);

		expect(screen.getByText("รอยแปรงยังไม่บันทึก")).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "เปิดแผงเลเยอร์เพื่อแก้รอยแปรงเลเยอร์ที่ยังไม่บันทึก" }));

		expect(setTool).toHaveBeenCalledWith("brush");
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(saveCurrentPage).not.toHaveBeenCalled();
	});

	it("routes AI-mask brush save failures back to the Clean brush panel with localized copy", async () => {
		projectStore.__setProjectForTesting(project());
		projectStore.saveSyncStatus = "error";
		projectStore.saveErrorMessage = "รอยแปรงยังไม่ถูกบันทึก (quota)";
		projectStore.saveErrorKind = "brush";
		editorStore.brushTarget = {
			kind: "ai-mask",
			label: "ผล AI ทั้งภาพ",
			labelCode: "aiMaskLegacy",
			title: "ผล AI ทั้งภาพ",
			titleCode: null,
			detail: "ลบพื้นที่ผล AI",
			scope: "ผล AI ทั้งภาพ",
			impact: "มีผลตอนบันทึก",
			eraseLabelCode: "aiMaskHide",
			restoreLabelCode: "aiMaskRestore",
			restoreHint: "คืนผล AI ก่อนปัด",
			canBrush: true,
			canRestore: true,
			canClearMask: true,
			tone: "ready",
		};
		const saveCurrentPage = vi.spyOn(projectStore, "saveCurrentPage").mockResolvedValue(undefined);
		const setTool = vi.spyOn(editorStore, "setTool").mockImplementation((tool: any) => {
			editorStore.currentTool = tool;
		});

		render(StatusBar);

		expect(screen.getByText("รอยแปรงยังไม่บันทึก")).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "เปิดแผงแปรงคลีนเพื่อแก้รอยแปรงที่ยังไม่บันทึก" }));

		expect(setTool).toHaveBeenCalledWith("brush");
		expect(editorUiStore.rightPanelMode).toBe("ai");
		expect(saveCurrentPage).not.toHaveBeenCalled();
	});

	it("keeps long status messages available as a title for truncated bars", () => {
		const longMessage = "Exported 2 pages to chapter.zip. Stored ZIP was not saved: Workspace storage is full.";
		projectStore.__setProjectForTesting(project());
		projectStore.statusMsg = longMessage;

		render(StatusBar);

		expect(screen.getByText(longMessage).getAttribute("title")).toBe(longMessage);
		expect(screen.getByText("งาน Save status test").getAttribute("title")).toBe("งาน Save status test");
	});

	it("requires a safe recovery copy before conflict reload from the app dialog", async () => {
		projectStore.__setProjectForTesting(project());
		projectStore.saveSyncStatus = "error";
		projectStore.saveErrorMessage = "งานถูกแก้จากแท็บอื่น";
		projectStore.saveErrorKind = "conflict";
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		const reloadProjectAfterConflict = vi.spyOn(projectStore, "reloadProjectAfterConflict").mockResolvedValue(true);
		const saveCurrentPage = vi.spyOn(projectStore, "saveCurrentPage").mockResolvedValue(undefined);
		const downloadLocalConflictCopy = vi.spyOn(projectStore, "downloadLocalConflictCopy").mockResolvedValue(undefined);

		render(StatusBar);

		expect(screen.getByText("แก้งานชนกัน")).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "เปิดตัวช่วยแก้งานบันทึกชนกัน" }));

		expect(confirm).not.toHaveBeenCalled();
		expect(reloadProjectAfterConflict).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog", { name: "มีเวอร์ชันใหม่บนเซิร์ฟเวอร์" })).toBeTruthy();
		expect(document.querySelector(".reload-confirmation-backdrop")).toBeTruthy();
		expect(screen.getByText(/งานในแท็บนี้ยังอยู่/)).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "ดาวน์โหลด JSON สำรอง" }));
		expect(downloadLocalConflictCopy).toHaveBeenCalledWith(editorStore.editor);

		await fireEvent.click(screen.getByRole("button", { name: "กลับไปดูงานในแท็บนี้" }));
		expect(screen.queryByRole("dialog", { name: "มีเวอร์ชันใหม่บนเซิร์ฟเวอร์" })).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "เปิดตัวช่วยแก้งานบันทึกชนกัน" }));
		await fireEvent.click(screen.getByRole("button", { name: "เก็บสำเนากู้คืน แล้วโหลดล่าสุด" }));

		expect(reloadProjectAfterConflict).toHaveBeenCalledWith(editorStore.editor, { createRecoveryCopy: true });
		expect(saveCurrentPage).not.toHaveBeenCalled();
	});

	it("opens the same conflict reload dialog when another chrome control requests it", async () => {
		projectStore.__setProjectForTesting(project());
		projectStore.saveSyncStatus = "error";
		projectStore.saveErrorKind = "conflict";
		projectStore.saveErrorMessage = "งานถูกแก้จากที่อื่น โหลดใหม่ก่อนบันทึก";

		render(StatusBar);

		window.dispatchEvent(new CustomEvent("manga-editor:request-conflict-reload"));
		await Promise.resolve();

		expect(screen.getByRole("dialog", { name: "มีเวอร์ชันใหม่บนเซิร์ฟเวอร์" })).toBeTruthy();
	});
});
