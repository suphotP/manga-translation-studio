import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import ProjectModePanel from "$lib/components/ProjectModePanel.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { SUPPORTED_IMAGE_ACCEPT } from "$lib/project/file-order.js";
import type { ProjectVersion, ProjectVersionDetail } from "$lib/api/client.js";
import type { AiReviewMarker, ExportRun, Page, ProjectState, WorkflowTask } from "$lib/types.js";

const now = "2026-05-12T12:34:00.000Z";

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
		name: "Project mode test",
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

function workflowTask(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
	return {
		id: "task-1",
		type: "typeset",
		status: "todo",
		priority: "normal",
		pageIndex: 0,
		title: "Typeset page",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function aiMarker(overrides: Partial<AiReviewMarker> = {}): AiReviewMarker {
	return {
		id: "ai-marker-1",
		jobId: "ai-job-1",
		pageIndex: 0,
		imageId: "image-1.webp",
		region: { x: 10, y: 20, w: 120, h: 80 },
		status: "accepted",
		tier: "clean-pro",
		resultImageId: "accepted-result.webp",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function exportRun(overrides: Partial<ExportRun> = {}): ExportRun {
	return {
		id: "export-run-1",
		kind: "batch-zip",
		status: "error",
		filename: "chapter_export.zip",
		pageIndexes: [0, 1],
		pageCount: 2,
		message: "Export failed: quota exceeded",
		error: "quota exceeded",
		createdAt: now,
		completedAt: now,
		...overrides,
	};
}

function projectVersion(overrides: Partial<ProjectVersion> = {}): ProjectVersion {
	return {
		versionId: "version-1",
		projectId: "project-1",
		name: "Snapshot 1",
		source: "save",
		createdAt: now,
		pageCount: 1,
		textLayerCount: 0,
		...overrides,
	};
}

function versionDetail(overrides: Partial<ProjectVersionDetail> = {}): ProjectVersionDetail {
	return {
		version: projectVersion(),
		diff: {
			current: {
				name: "Current",
				pageCount: 1,
				textLayerCount: 0,
				pages: [],
			},
			snapshot: {
				name: "Snapshot",
				pageCount: 1,
				textLayerCount: 0,
				pages: [],
			},
			pageDelta: 0,
			textLayerDelta: 0,
			changedPageCount: 0,
			changedPages: [],
		},
		reviews: [],
		...overrides,
	};
}

function resetStores(): void {
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	editorStore.currentTool = "select";
	editorStore.selectedLayer = null;
	editorStore.textLayers = [];
	editorStore.editor = null;
	editorStore.hasImage = false;
	window.localStorage.clear();
	vi.restoreAllMocks();
}

async function openPagesInspector(): Promise<void> {
	await fireEvent.click(screen.getByRole("button", { name: "ส่วนหน้า ปิดอยู่" }));
}

beforeEach(() => {
	resetStores();
});

describe("ProjectModePanel", () => {
	it("summarizes project context and offers exits into wider project surfaces", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [page({ imageName: "page-1.webp" }), page({ imageName: "page-2.webp" })],
			tasks: [workflowTask({ id: "task-open-1", status: "todo" })],
		}));

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		expect(screen.getByRole("region", { name: "สรุปงาน" })).toBeTruthy();
		expect(screen.getByText("Project mode test")).toBeTruthy();
		expect(screen.getByText("หน้า 1/2")).toBeTruthy();
		expect(screen.getByText("งานค้างพร้อมทำ")).toBeTruthy();
		expect(screen.getByRole("button", { name: "ส่วนหน้า ปิดอยู่" })).toBeTruthy();
		expect(screen.queryByRole("region", { name: "โฟกัสหน้าปัจจุบัน" })).toBeNull();

		const surfaceActions = screen.getByLabelText("ทางลัดเปิดเวิร์กสเปซ");
		expect(within(surfaceActions).getByRole("button", { name: /คลังงาน/ })).toBeTruthy();
		expect(within(surfaceActions).getByRole("button", { name: /หน้าในตอน/ })).toBeTruthy();
		expect(within(surfaceActions).getByRole("button", { name: /บอร์ดทีม/ })).toBeTruthy();

		editorUiStore.setWorkspaceView("editor");
		await fireEvent.click(within(surfaceActions).getByRole("button", { name: /คลังงาน/ }));
		expect(editorUiStore.workspaceView).toBe("library");
		await waitFor(() => expect(window.location.pathname).toBe("/library"));

		editorUiStore.setWorkspaceView("editor");
		await fireEvent.click(within(surfaceActions).getByRole("button", { name: /หน้าในตอน/ }));
		expect(editorUiStore.workspaceView).toBe("pages");
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/pages"));

		// Focus mode was removed: the project surface "บอร์ดทีม" shortcut opens the team Work Board.
		editorUiStore.setWorkspaceView("editor");
		await fireEvent.click(within(surfaceActions).getByRole("button", { name: /บอร์ดทีม/ }));
		expect(editorUiStore.workspaceView).toBe("work");
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/work"));
	});

	it("shows passive project route receipts when no project is open", () => {
		projectStore.__setProjectForTesting(null);

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		const surfaceActions = screen.getByLabelText("ทางลัดเปิดเวิร์กสเปซ");
		expect(within(surfaceActions).queryByRole("button", { name: /หน้าในตอน/ })).toBeNull();
		expect(within(surfaceActions).queryByRole("button", { name: /บอร์ดทีม/ })).toBeNull();
		expect(within(surfaceActions).getByText("หน้าในตอน")).toBeTruthy();
		expect(within(surfaceActions).getByText("บอร์ดทีม")).toBeTruthy();
		expect(within(surfaceActions).getAllByText("เปิดงานก่อน").length).toBe(2);
	});

	it("shows local recovery drafts and confirms restore inside the app", async () => {
		projectStore.__setProjectForTesting(project());
		const draft = {
			kind: "manga-editor-conflict-local-copy",
			id: "draft-ui-1",
			exportedAt: "2026-05-20T09:00:00.000Z",
			reason: "project_save_conflict",
			message: "งานถูกแก้จากที่อื่น",
			projectId: "project-1",
			projectName: "Recovered UI Chapter",
			pageIndex: 0,
			pageCount: 2,
			textLayerCount: 3,
			imageLayerCount: 1,
			project: project({
				name: "Recovered UI Chapter",
				pages: [page(), page({ imageId: "image-2.webp", imageName: "image-2.webp" })],
			}),
		};
		window.localStorage.setItem("manga-editor:conflict-recovery:index", JSON.stringify([draft.id]));
		window.localStorage.setItem(`manga-editor:conflict-recovery:${draft.id}`, JSON.stringify(draft));
		const restoreDraft = vi.spyOn(projectStore, "restoreLocalConflictRecoveryDraft").mockResolvedValue(true);

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "ส่วนสำเนากู้คืน ปิดอยู่" }));
		expect(screen.getByText("Recovered UI Chapter")).toBeTruthy();
		expect(screen.getByText("2 หน้า / ข้อความ 3 / รูป 1")).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "กู้คืน" }));

		expect(screen.getByRole("dialog", { name: "กู้คืนงานจากสำเนาในเครื่อง?" })).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "ยืนยันกู้คืน" }));
		expect(restoreDraft).toHaveBeenCalledWith("draft-ui-1", editorStore.editor);
	});

	it("puts open version review state in the summary before the dense version list", async () => {
		projectStore.__setProjectForTesting(project({
			versionReviewRequests: [{
				id: "review-1",
				versionId: "version-1",
				status: "open",
				requester: "qc",
				createdAt: now,
				updatedAt: now,
			}],
		}));
		const loadVersions = vi.spyOn(projectStore, "loadVersions").mockResolvedValue(undefined);

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		expect(screen.getByText("มีผลรีวิวเวอร์ชันรออยู่")).toBeTruthy();
		expect(screen.getByText("ผลรีวิวเวอร์ชันเปิดอยู่")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "เปิดเวอร์ชัน" }));

		expect(loadVersions).toHaveBeenCalledTimes(1);
		expect(screen.getByRole("button", { name: "ส่วนหน้า ปิดอยู่" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "ส่วนเวอร์ชัน เปิดอยู่" })).toBeTruthy();
	});

	it("prioritizes accepted AI results that still need placement before generic version review", async () => {
		editorStore.editor = { focusImageRegion: vi.fn() } as any;
		projectStore.__setProjectForTesting(project({
			pages: [page({
				textLayers: [{
					id: "text-1",
					text: "Translated",
					x: 10,
					y: 20,
					w: 120,
					h: 48,
					rotation: 0,
					fontSize: 24,
					alignment: "center",
					index: 0,
				}],
			})],
			aiReviewMarkers: [aiMarker()],
			versionReviewRequests: [{
				id: "review-1",
				versionId: "version-1",
				status: "open",
				requester: "qc",
				createdAt: now,
				updatedAt: now,
			}],
		}));

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

			expect(screen.getByText("Export ยังไม่พร้อม")).toBeTruthy();
			expect(screen.getByText("หน้า 1: 1 ผล AI ผ่านแล้วแต่ยังไม่วาง")).toBeTruthy();
			// Status-not-coaching: the card reports the blocker; no "do this" line.
			expect(screen.queryByText("วางผล AI ที่ผ่านแล้วเป็นเลเยอร์")).toBeNull();
			await fireEvent.click(screen.getByRole("button", { name: "วางเลเยอร์ AI" }));
			expect(projectStore.selectedAiReviewMarkerId).toBe("ai-marker-1");
			expect(editorStore.editor.focusImageRegion).toHaveBeenCalledWith({ x: 10, y: 20, w: 120, h: 80 });
			expect(editorUiStore.rightPanelMode).toBe("layers");
			await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
			expect(projectStore.statusMsg).toBe("เปิดจุดวางเลเยอร์ AI แล้ว");
			expect(screen.queryByText("มี Review เวอร์ชันรออยู่")).toBeNull();
		});

	it("renders pages and delegates version toolbar actions", async () => {
		const version = projectVersion();
		projectStore.__setProjectForTesting(project());
		projectStore.versions = [version];
		const loadVersions = vi.spyOn(projectStore, "loadVersions").mockResolvedValue(undefined);
		const loadVersionDetail = vi.spyOn(projectStore, "loadVersionDetail").mockResolvedValue(undefined);

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		expect(screen.getByRole("button", { name: "ส่วนหน้า ปิดอยู่" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "ส่วนเวอร์ชัน ปิดอยู่" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "ส่วนเวอร์ชัน ปิดอยู่" }));
		expect(screen.getByRole("button", { name: "ส่วนหน้า ปิดอยู่" })).toBeTruthy();
		expect(screen.getByText("1 จุดบันทึก")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "โหลดใหม่" }));
		await fireEvent.click(screen.getAllByRole("button", { name: "รายละเอียด" })[0]);

		expect(loadVersions).toHaveBeenCalledTimes(2);
		expect(loadVersionDetail).toHaveBeenCalledWith(version.versionId);
	});

	it("confirms version restore inside the app instead of using a native confirm", async () => {
		const version = projectVersion();
		projectStore.__setProjectForTesting(project());
		projectStore.versions = [version];
		const restoreVersion = vi.spyOn(projectStore, "restoreVersion").mockResolvedValue(undefined);
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
		vi.spyOn(projectStore, "loadVersions").mockResolvedValue(undefined);

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "ส่วนเวอร์ชัน ปิดอยู่" }));
		await fireEvent.click(screen.getByRole("button", { name: "ย้อนกลับไปเวอร์ชันที่เลือก" }));

		expect(confirmSpy).not.toHaveBeenCalled();
		expect(restoreVersion).not.toHaveBeenCalled();
		const restoreDialog = screen.getByRole("dialog", { name: "ย้อนงานไปจุดบันทึกนี้?" });
		expect(restoreDialog).toBeTruthy();
		// Reskin (W3.2): confirmation uses the shared ws Dialog atom shell, not a bespoke modal.
		expect(restoreDialog.classList.contains("ws-dialog-panel")).toBe(true);

		await fireEvent.click(screen.getByRole("button", { name: "ยกเลิก" }));
		expect(screen.queryByRole("dialog", { name: "ย้อนงานไปจุดบันทึกนี้?" })).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "ย้อนกลับไปเวอร์ชันที่เลือก" }));
		await fireEvent.click(screen.getByRole("button", { name: "ยืนยันย้อนกลับ" }));

		expect(restoreVersion).toHaveBeenCalledWith(version.versionId, editorStore.editor);
	});

	it("starts Pages with a current-page focus card before dense page controls", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [page({ imageName: "page-1.webp" }), page({ imageName: "page-2.webp" })],
			tasks: [workflowTask({ id: "task-open-1", status: "todo", pageIndex: 0 })],
		}));

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		await openPagesInspector();

		const focusCard = screen.getByRole("region", { name: "โฟกัสหน้าปัจจุบัน" });
		expect(within(focusCard).getByText("รอรีวิวผล")).toBeTruthy();
		expect(within(focusCard).getByText("หน้า 1: page-1")).toBeTruthy();
		// Status-not-coaching: the focus card no longer instructs.
		expect(within(focusCard).queryByText("ตรวจคำเตือนและงานส่งต่อ")).toBeNull();
		expect(within(focusCard).getByText(/1 งานเปิด/)).toBeTruthy();
		expect(within(focusCard).getByRole("button", { name: "เลือกหน้าปัจจุบันเข้าชุด" })).toBeTruthy();
		expect(within(focusCard).getByRole("button", { name: "ตรวจ gate Export ของหน้าปัจจุบัน" })).toBeTruthy();
	});

	it("makes required-credit batch export readiness match the central Public/Export gate", async () => {
		projectStore.__setProjectForTesting(project({
			creditPolicy: "required",
			pages: [
				page({ imageName: "page-1.webp", textLayers: [{ id: "layer-1", text: "พร้อม Export" } as any] }),
				page({ imageName: "page-2.webp", textLayers: [{ id: "layer-2", text: "พร้อม Export" } as any] }),
			],
		}));

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		await openPagesInspector();

		const actionBar = screen.getByLabelText("คำสั่งจัดการหลายหน้า");
		expect(screen.getAllByText("0/2 พร้อม เผยแพร่/ส่งออก").length).toBeGreaterThanOrEqual(1);
		expect(screen.queryByText("2/2 พร้อมส่งออก")).toBeNull();
		expect(within(actionBar).getByRole("button", { name: "เช็ก Public" })).toBeTruthy();
		expect(within(actionBar).getByRole("button", { name: "Export ZIP" })).toBeTruthy();
		expect(within(actionBar).getByRole("button", { name: "เปิดเครดิต" })).toBeTruthy();

		await fireEvent.click(within(actionBar).getByRole("button", { name: "เช็ก Public" }));
		expect(within(actionBar).getByText("ส่งออกยังไม่พร้อม: เผยแพร่/ส่งออก ต้องมีเครดิตอย่างน้อย 1 รายการในตอนนี้")).toBeTruthy();

		await fireEvent.click(within(actionBar).getByRole("button", { name: "เปิดเครดิต" }));
		expect(editorUiStore.workspaceView).toBe("editor");
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(projectStore.statusMsg).toBe("เปิดเครื่องมือเครดิตในแผงเลเยอร์แล้ว");
	});

	it("opens a requested version review target when Work mode routes into Project mode", async () => {
		projectStore.__setProjectForTesting(project());
		projectStore.versions = [projectVersion()];
		projectStore.versionDetail = versionDetail();
		const loadVersions = vi.spyOn(projectStore, "loadVersions").mockResolvedValue(undefined);
		const loadVersionDetail = vi.spyOn(projectStore, "loadVersionDetail").mockResolvedValue(undefined);

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: "version-1",
				openVersionToken: 1,
			},
		});

		await waitFor(() => {
			expect(loadVersionDetail).toHaveBeenCalledWith("version-1");
		});

		expect(loadVersions).toHaveBeenCalledTimes(1);
		expect(screen.getByRole("button", { name: "ส่วนหน้า ปิดอยู่" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "ส่วนเวอร์ชัน เปิดอยู่" })).toBeTruthy();
		expect(screen.getByText("เปลี่ยนแปลง: 0 หน้า / 0 เลเยอร์ข้อความ, 0 หน้ามีการเปลี่ยน")).toBeTruthy();
	});

	it("does not open stale version review targets whose snapshot was pruned", async () => {
		projectStore.__setProjectForTesting(project());
		projectStore.versions = [];
		projectStore.versionDetail = versionDetail({ version: projectVersion({ versionId: "previous-version" }) });
		const loadVersions = vi.spyOn(projectStore, "loadVersions").mockResolvedValue(undefined);
		const loadVersionDetail = vi.spyOn(projectStore, "loadVersionDetail").mockResolvedValue(undefined);

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: "missing-version",
				openVersionToken: 1,
			},
		});

		await waitFor(() => {
			expect(loadVersions).toHaveBeenCalledTimes(1);
		});

		expect(loadVersionDetail).not.toHaveBeenCalled();
		expect(projectStore.versionDetail).toBeNull();
		expect(projectStore.statusMsg).toBe("จุดบันทึกสำหรับคำขอตรวจหายหรือถูกล้างจากประวัติในเครื่อง");
		expect(screen.getByRole("button", { name: "ส่วนหน้า ปิดอยู่" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "ส่วนเวอร์ชัน เปิดอยู่" })).toBeTruthy();
	});

	it("keeps dense project sections exclusive inside the inspector", async () => {
		projectStore.__setProjectForTesting(project());
		projectStore.versions = [projectVersion()];
		vi.spyOn(projectStore, "loadVersions").mockResolvedValue(undefined);

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		expect(screen.getByRole("button", { name: "ส่วนหน้า ปิดอยู่" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "ส่วนการใช้งาน ปิดอยู่" }));
		expect(screen.getByRole("button", { name: "ส่วนหน้า ปิดอยู่" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "ส่วนการใช้งาน เปิดอยู่" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "ส่วนเวอร์ชัน ปิดอยู่" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "ส่วนเวอร์ชัน ปิดอยู่" }));
		expect(screen.getByRole("button", { name: "ส่วนหน้า ปิดอยู่" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "ส่วนการใช้งาน ปิดอยู่" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "ส่วนเวอร์ชัน เปิดอยู่" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "ส่วนหน้า ปิดอยู่" }));
		expect(screen.getByRole("button", { name: "ส่วนหน้า เปิดอยู่" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "ส่วนการใช้งาน ปิดอยู่" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "ส่วนเวอร์ชัน ปิดอยู่" })).toBeTruthy();
	});

	it("delegates batch due-date operations for active open tasks", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [page({ imageName: "page-1.webp" }), page({ imageName: "page-2.webp" })],
			tasks: [
				workflowTask({ id: "task-open-1", pageIndex: 0, status: "todo" }),
				workflowTask({ id: "task-done", pageIndex: 0, status: "done" }),
				workflowTask({ id: "task-open-2", pageIndex: 1, status: "doing" }),
			],
		}));
		const bulkUpdateTaskDueAt = vi.spyOn(projectStore, "bulkUpdateTaskDueAt").mockResolvedValue(2);
		const dueValue = "2026-05-14T09:15";

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		await openPagesInspector();

		await fireEvent.input(screen.getByLabelText("วันครบกำหนดของงานเปิดในชุดนี้"), {
			target: { value: dueValue },
		});
		await fireEvent.click(screen.getByRole("button", { name: "ตั้งวันครบกำหนดให้งานเปิดในชุดนี้" }));
		await fireEvent.click(screen.getByRole("button", { name: "ล้างวันครบกำหนดของงานเปิดในชุดนี้" }));

		expect(bulkUpdateTaskDueAt).toHaveBeenNthCalledWith(
			1,
			["task-open-1", "task-open-2"],
			new Date(dueValue).toISOString(),
		);
		expect(bulkUpdateTaskDueAt).toHaveBeenNthCalledWith(
			2,
			["task-open-1", "task-open-2"],
			null,
		);
	});

	it("renders export history and delegates retry actions", async () => {
		const run = exportRun({ targetProfile: "public-export" });
		projectStore.__setProjectForTesting(project({
			pages: [
				page({ imageName: "page-1.webp", textLayers: [{ id: "layer-1", text: "พร้อม Export" } as any] }),
				page({ imageName: "page-2.webp", textLayers: [{ id: "layer-2", text: "พร้อม Export" } as any] }),
			],
			exportRuns: [run],
		}));
		const retryExportRun = vi.spyOn(projectStore, "retryExportRun").mockResolvedValue(undefined);

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		await openPagesInspector();

		expect(screen.getByText("ประวัติ Export")).toBeTruthy();
		expect(screen.getByText("chapter_export.zip")).toBeTruthy();
		expect(screen.getByText("Export ไม่สำเร็จ: quota exceeded")).toBeTruthy();
		expect(screen.getByText(/เผยแพร่\/ส่งออก \/ ZIP ทั้งชุด/)).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "ทำ ZIP ใหม่ chapter_export.zip" }));

		expect(retryExportRun).toHaveBeenCalledWith(run.id, editorStore.editor, [0, 1]);
	});

	it("shows export retry blockers before delegating blocked batch history", async () => {
		const run = exportRun();
		projectStore.__setProjectForTesting(project({
			pages: [
				page({ imageName: "page-1.webp", textLayers: [{ id: "layer-1", text: "พร้อม Export" } as any] }),
				// page-2 carries a GENUINE export blocker: a text layer with empty text
				// (an `empty_text_layer` QC error). A page being text-less (art-only) is
				// NO LONGER a blocker on its own — aligned with the backend readiness
				// contract — so the single checklist item is this real QC error.
				page({ imageName: "page-2.webp", textLayers: [{ id: "layer-2", text: "" } as any] }),
			],
			exportRuns: [run],
		}));
		const retryExportRun = vi.spyOn(projectStore, "retryExportRun").mockResolvedValue(undefined);

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		await openPagesInspector();

		expect(screen.queryByRole("button", { name: "ทำ ZIP ใหม่ chapter_export.zip" })).toBeNull();
		expect(screen.getByText("รอเคลียร์").getAttribute("title")).toBe("ส่งออกยังไม่พร้อม: 1 หน้าต้องเคลียร์ 1 รายการ");

		expect(retryExportRun).not.toHaveBeenCalled();
	});

	it("explains export history retry lock while a batch export is running", async () => {
		const run = exportRun({ pageIndexes: [0], pageCount: 1 });
		projectStore.__setProjectForTesting(project({
			pages: [page({ imageName: "page-1.webp", textLayers: [{ id: "layer-1", text: "พร้อม Export" } as any] })],
			exportRuns: [run],
		}));
		projectStore.batchExportStatus = "checking";

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		await openPagesInspector();

		expect(screen.queryByRole("button", { name: "ทำ ZIP ใหม่ chapter_export.zip" })).toBeNull();
		expect(screen.getAllByText("กำลัง Export").some((item) => item.getAttribute("title") === "กำลัง Export อยู่")).toBe(true);
	});

	it("downloads a session-available batch export from project history", async () => {
		const run = exportRun({
			id: "export-done",
			status: "done",
			pageIndexes: [0],
			pageCount: 1,
			message: "Exported chapter_export.zip",
			error: undefined,
			artifactError: "Stored ZIP was not saved: Workspace storage is full.",
		});
		projectStore.__setProjectForTesting(project({
			pages: [page({ imageName: "page-1.webp", textLayers: [{ id: "layer-1", text: "พร้อม Export" } as any] })],
			exportRuns: [run],
		}));
		vi.spyOn(projectStore, "canDownloadExportRun").mockReturnValue(true);
		const downloadExportRun = vi.spyOn(projectStore, "downloadExportRun").mockImplementation(() => {});

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		await openPagesInspector();

		const downloadButton = screen.getByRole("button", { name: "ดาวน์โหลด Export chapter_export.zip" });
		expect(downloadButton.getAttribute("title")).toBe("ดาวน์โหลด chapter_export.zip");
		await fireEvent.click(downloadButton);

		expect(downloadExportRun).toHaveBeenCalledWith("export-done");
	});

	it("removes a persisted batch export artifact from project history", async () => {
		const run = exportRun({
			id: "export-done",
			status: "done",
			pageIndexes: [0],
			pageCount: 1,
			message: "Exported chapter_export.zip",
			error: undefined,
			artifact: {
				exportId: "export-done.zip",
				storageDriver: "local",
				storageKey: "projects/project-1/exports/export-done.zip",
				filename: "chapter_export.zip",
				mimeType: "application/zip",
				sizeBytes: 7,
				createdAt: now,
			},
		});
		projectStore.__setProjectForTesting(project({
			pages: [page({ imageName: "page-1.webp", textLayers: [{ id: "layer-1", text: "พร้อม Export" } as any] })],
			exportRuns: [run],
		}));
		const deleteExportArtifact = vi.spyOn(projectStore, "deleteExportArtifact").mockResolvedValue();

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		await openPagesInspector();

		const removeButton = screen.getByRole("button", { name: "ลบไฟล์ Export ที่เก็บไว้ chapter_export.zip" });
		expect(removeButton.getAttribute("title")).toBe("ลบ ZIP ที่เก็บไว้ของ chapter_export.zip เพื่อคืนพื้นที่");
		expect(screen.getByText("ZIP เก็บถาวร / นับพื้นที่")).toBeTruthy();
		await fireEvent.click(removeButton);

		expect(deleteExportArtifact).toHaveBeenCalledWith("export-done");
	});

	it("keeps older retained export artifacts visible in project history", async () => {
		const runs = [
			...Array.from({ length: 4 }, (_, index) => exportRun({
				id: `export-recent-${index}`,
				status: "done",
				pageIndexes: [0],
				pageCount: 1,
				filename: `recent-${index}.zip`,
				message: `Exported recent-${index}.zip`,
				error: undefined,
			})),
			exportRun({
				id: "export-retained-old",
				status: "done",
				pageIndexes: [0],
				pageCount: 1,
				filename: "old-stored.zip",
				message: "Exported old-stored.zip",
				error: undefined,
				artifact: {
					exportId: "old-stored.zip",
					storageDriver: "local",
					storageKey: "projects/project-1/exports/old-stored.zip",
					filename: "old-stored.zip",
					mimeType: "application/zip",
					sizeBytes: 7,
					createdAt: now,
				},
			}),
		];
		projectStore.__setProjectForTesting(project({
			pages: [page({ imageName: "page-1.webp", textLayers: [{ id: "layer-1", text: "พร้อม Export" } as any] })],
			exportRuns: runs,
		}));

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		await openPagesInspector();

		expect(screen.getByText("old-stored.zip")).toBeTruthy();
		expect(screen.getByRole("button", { name: "ลบไฟล์ Export ที่เก็บไว้ old-stored.zip" })).toBeTruthy();
	});

	it("disables project export download when the session blob is gone", async () => {
		const run = exportRun({
			id: "export-done",
			status: "done",
			pageIndexes: [0],
			pageCount: 1,
			message: "Exported chapter_export.zip",
			error: undefined,
			artifactError: "Stored ZIP was not saved: Workspace storage is full.",
		});
		projectStore.__setProjectForTesting(project({
			pages: [page({ imageName: "page-1.webp", textLayers: [{ id: "layer-1", text: "พร้อม Export" } as any] })],
			exportRuns: [run],
		}));

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		await openPagesInspector();

		expect(screen.queryByRole("button", {
				name: "ดาวน์โหลด Export chapter_export.zip",
		})).toBeNull();
		expect(screen.getByRole("button", {
			name: "ทำ ZIP ใหม่ chapter_export.zip",
		})).toBeTruthy();
		expect(screen.getByText("เก็บ ZIP ไม่สำเร็จ / สร้างใหม่หลังคืนพื้นที่")).toBeTruthy();
		expect(screen.getByText("เก็บ ZIP ไม่สำเร็จ: Storage ของเวิร์กสเปซเต็ม")).toBeTruthy();
	});

	it("focuses pages from export history before retrying", async () => {
		const run = exportRun({ pageIndexes: [1], pageCount: 1 });
		projectStore.__setProjectForTesting(project({
			pages: [page({ imageName: "page-1.webp" }), page({ imageName: "page-2.webp" })],
			exportRuns: [run],
		}));
		const goToPage = vi.spyOn(projectStore, "goToPage").mockResolvedValue(undefined);

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		await openPagesInspector();

		await fireEvent.click(screen.getByRole("button", { name: "โฟกัสหน้า Export chapter_export.zip" }));

		expect(goToPage).toHaveBeenCalledWith(1, editorStore.editor);
		expect(projectStore.statusMsg).toBe("เลือกหน้า Export history แล้ว");
		expect(screen.getByText("เลือก 1 หน้าใน export history แล้ว")).toBeTruthy();
	});

	it("marks stale export history as unavailable instead of retrying missing pages", async () => {
		const run = exportRun({ pageIndexes: [4], pageCount: 1 });
		projectStore.__setProjectForTesting(project({
			pages: [page({ imageName: "page-1.webp" })],
			exportRuns: [run],
		}));
		const retryExportRun = vi.spyOn(projectStore, "retryExportRun").mockResolvedValue(undefined);

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		await openPagesInspector();

		expect(screen.queryByRole("button", { name: "โฟกัสหน้า Export chapter_export.zip" })).toBeNull();
		expect(screen.getByText("ไม่มีหน้า").getAttribute("title")).toBe("หน้าในประวัติ Export ไม่อยู่ในงานนี้แล้ว");
		expect(screen.queryByRole("button", { name: "ทำ ZIP ใหม่ chapter_export.zip" })).toBeNull();
		expect(screen.getByText("รอเคลียร์").getAttribute("title")).toBe("หน้าในประวัติ Export ไม่อยู่ในงานนี้แล้ว");

		expect(retryExportRun).not.toHaveBeenCalled();
	});

	it("syncs editor page navigation into the page-specific canvas URL", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [page({ imageName: "page-1.webp" }), page({ imageName: "page-2.webp" })],
		}));
		editorUiStore.setWorkspaceView("editor");

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		await openPagesInspector();

		await fireEvent.click(screen.getByRole("button", { name: "หน้าถัดไป" }));

		expect(projectStore.project?.currentPage).toBe(1);
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/pages/2/editor"));
	});

	it("surfaces current page asset recovery actions when the image asset is missing", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [page({ imageId: "", imageName: "missing-page.webp" })],
		}));

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		await openPagesInspector();

		expect(screen.getByRole("status", { name: "กู้รูปหน้า 1" })).toBeTruthy();
		expect(screen.getByText("รูปหน้าหาย")).toBeTruthy();
		expect(screen.getByText(/กู้รูปหน้านี้หรือจับคู่โฟลเดอร์รูป/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "กู้รูปหน้านี้" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "จับคู่โฟลเดอร์" })).toBeTruthy();
	});

	it("uses the supported image picker for relink actions", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [page({ imageId: "", imageName: "missing-page.webp" })],
		}));

		render(ProjectModePanel, {
			props: {
				labels: { pages: "Pages" },
				openVersionId: null,
				openVersionToken: 0,
			},
		});

		await openPagesInspector();

		const createdInputs: HTMLInputElement[] = [];
		const createElement = document.createElement.bind(document);
		vi.spyOn(document, "createElement").mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
			const element = createElement(tagName, options);
			if (tagName.toLowerCase() === "input") {
				createdInputs.push(element as HTMLInputElement);
				vi.spyOn(element as HTMLInputElement, "click").mockImplementation(() => undefined);
			}
			return element;
		}) as typeof document.createElement);

		await fireEvent.click(screen.getByRole("button", { name: "กู้รูปหน้านี้" }));
		await fireEvent.click(screen.getByRole("button", { name: "จับคู่โฟลเดอร์" }));

		expect(createdInputs).toHaveLength(2);
		expect(createdInputs[0].accept).toBe(SUPPORTED_IMAGE_ACCEPT);
		expect(createdInputs[0].multiple).toBe(false);
		expect(createdInputs[1].accept).toBe(SUPPORTED_IMAGE_ACCEPT);
		expect(createdInputs[1].multiple).toBe(true);
	});
});
