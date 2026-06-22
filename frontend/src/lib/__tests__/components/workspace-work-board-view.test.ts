import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import "$lib/i18n";
import WorkspaceWorkBoardView from "$lib/components/WorkspaceWorkBoardView.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type { AiReviewMarker, ProjectState } from "$lib/types.js";

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
		tasks: [
			{
				id: "task-1",
				type: "clean",
				status: "todo",
				priority: "urgent",
				pageIndex: 1,
				title: "Clean page 2",
				assignee: "Mai",
				dueAt: "2026-05-13T10:00:00.000Z",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "task-2",
				type: "review",
				status: "review",
				priority: "high",
				pageIndex: 0,
				title: "Review page 1",
				createdAt: now,
				updatedAt: now,
			},
		],
		comments: [
			{
				id: "comment-1",
				pageIndex: 0,
				body: "Check redraw edge",
				author: "Reviewer",
				status: "open",
				createdAt: now,
				updatedAt: now,
			},
		],
	};
}

function zeroPageProject(): ProjectState {
	const state = project();
	state.name = "upload-probe";
	state.pages = [];
	state.tasks = [
		{
			id: "stale-task-1",
			type: "clean",
			status: "todo",
			priority: "urgent",
			pageIndex: 0,
			title: "Clean page 1",
			assignee: "Mai",
			dueAt: "2026-05-13T10:00:00.000Z",
			createdAt: now,
			updatedAt: now,
		},
	];
	state.comments = [
		{
			id: "stale-comment-1",
			pageIndex: 0,
			body: "Check missing page",
			author: "Reviewer",
			status: "open",
			createdAt: now,
			updatedAt: now,
		},
	];
	return state;
}

function aiReviewMarker(overrides: Partial<AiReviewMarker> = {}): AiReviewMarker {
	return {
		id: "marker-1",
		jobId: "job-1",
		pageIndex: 0,
		imageId: "image-1",
		region: { x: 20, y: 30, w: 120, h: 80 },
		status: "accepted",
		tier: "clean-pro",
		resultImageId: "ai-result-1",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

beforeEach(() => {
	vi.restoreAllMocks();
	window.history.pushState({}, "", "/projects/project-1/work");
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	editorStore.textLayers = [];
	editorStore.imageLayers = [];
	editorStore.editor = null;
});

async function openQueueOverview(): Promise<void> {
	const summary = screen.queryByText("รายละเอียดคิวทั้งหมด") ?? screen.getByText("งานทั้งหมด");
	await fireEvent.click(summary);
}

describe("WorkspaceWorkBoardView", () => {
	it("shows a single import-first state when a chapter has zero pages", async () => {
		projectStore.__setProjectForTesting(zeroPageProject());
		editorUiStore.openWorkBoard();

		render(WorkspaceWorkBoardView);

		expect(screen.getByRole("heading", { name: "upload-probe" })).toBeTruthy();
		const emptyState = screen.getByRole("region", { name: "ตอนนี้ยังไม่มีหน้า" });
		expect(within(emptyState).getByRole("heading", { name: "ยังไม่มีหน้า — Import รูปก่อน" })).toBeTruthy();
		expect(within(emptyState).getByRole("button", { name: "Import รูปหน้า" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "เปิดหน้า 1" })).toBeNull();
		expect(screen.queryByText(/งานเปิด \/ .*งานด่วน/)).toBeNull();
		expect(screen.queryByRole("region", { name: "สถานะพร้อม Export ตอน" })).toBeNull();
		expect(screen.queryByRole("region", { name: "รูปแบบงาน" })).toBeNull();
		expect(screen.queryByLabelText("สรุปงานในบอร์ด")).toBeNull();
		expect(screen.queryByText("ยัง Export ไม่ได้")).toBeNull();
		expect(screen.queryByText("หน้านี้เลื่อนครบทุกขั้นแล้ว")).toBeNull();
		expect(screen.queryByText("งานทั้งหมด")).toBeNull();

		await fireEvent.click(within(emptyState).getByRole("button", { name: "Import รูปหน้า" }));

		// Routes through the SAME fill-existing chapter-setup flow as the other
		// zero-page entry points — the text Import/Review surface cannot attach
		// page images and would dead-end the user (codex P2).
		await waitFor(() => expect(editorUiStore.chapterSetupOpen).toBe(true));
		expect(editorUiStore.chapterSetupContext.mode).toBe("fill-existing-zero-page");
		expect(editorUiStore.chapterSetupContext.projectId).toBe("project-1");
	});

	it("renders a wide project work board with handoffs, assigned work, and role lanes", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openWorkBoard();

		render(WorkspaceWorkBoardView);

		expect(screen.getByRole("region", { name: "บอร์ดงานตอน" })).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Alpha Chapter 1" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "เปิดหน้า 1" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "เปิดหน้าแก้" })).toBeNull();
		await fireEvent.click(screen.getByText("ไปหน้าอื่น"));
		expect(screen.getByRole("button", { name: "ดูงานค้าง" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "คิวงาน" })).toBeNull();
		expect(screen.getByText("งานด่วน")).toBeTruthy();
		const soloBlocker = screen.getByRole("region", { name: "คำสั่งตัวบล็อกสำหรับ solo" });
		expect(within(soloBlocker).getByText("คลีน หน้า 2")).toBeTruthy();
		expect(within(soloBlocker).queryByText("Page 2 - Clean page 2")).toBeNull();
		expect(within(soloBlocker).getByText(/หน้า 2 \/ @Mai/)).toBeTruthy();
		expect(screen.getByText("รายละเอียดงานเพิ่มเติม")).toBeTruthy();
		await fireEvent.click(screen.getByText("รายละเอียดงานเพิ่มเติม"));
		expect(screen.getByRole("group", { name: "คำสั่งตรวจโน้ต" })).toBeTruthy();
		expect(screen.getByRole("group", { name: "คำสั่งรีวิว AI และ QC" })).toBeTruthy();
		expect(screen.getByRole("group", { name: "คำสั่งตัดสินผลรีวิว" })).toBeTruthy();
		expect(screen.getByRole("group", { name: "คำสั่งปลดตัวบล็อก" })).toBeTruthy();
		expect(screen.queryByRole("region", { name: "ทีมผลิตแยกบทบาท" })).toBeNull();
		expect(screen.queryByRole("region", { name: "คำสั่งคนรับงานและตัวบล็อก" })).toBeNull();
		expect(screen.queryByText("ใครรับไม้ต่อ")).toBeNull();
		expect(screen.queryByText("กำหนดคนรับงานก่อนส่งต่อให้ทีม")).toBeNull();
		await openQueueOverview();
		expect(screen.getByText("รายละเอียดคิวทั้งหมด")).toBeTruthy();
		expect(screen.getByText("5 งานด่วน / เปิดดูขั้นงานละเอียด")).toBeTruthy();
		expect(screen.queryByRole("region", { name: "คิวคนรับงาน" })).toBeNull();
		expect(screen.queryByText("คิวตามขั้นตอน")).toBeNull();
		expect(screen.getByRole("region", { name: "ขั้นงานละเอียด" })).toBeTruthy();
		expect(screen.getByText("ขั้นงานละเอียด")).toBeTruthy();
		expect(screen.getByRole("button", { name: /งาน \/ หน้า 2 \/ เลยกำหนด .*คลีน หน้า 2/ })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /งาน \/ หน้า 2 \/ เลยกำหนด \/ @Mai/ })).toBeNull();
		expect(screen.queryByText("หน้า 2 - คลีนหน้า")).toBeNull();
	});

	it("lets users switch Solo and Team ownership from the Work board itself", async () => {
		const state = project();
		state.tasks = [];
		state.comments = [];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openWorkBoard();

		render(WorkspaceWorkBoardView);

		const modeStrip = screen.getByRole("region", { name: "รูปแบบงาน" });
		expect(within(modeStrip).getAllByText("ทำคนเดียว")).toHaveLength(2);
		expect(within(modeStrip).getByText("งานแรก / ตัวบล็อก")).toBeTruthy();
		expect(within(modeStrip).getByRole("button", { name: /ทำคนเดียว/ }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.queryByRole("region", { name: "ทีมผลิตแยกบทบาท" })).toBeNull();

		await fireEvent.click(within(modeStrip).getByRole("button", { name: /ทีมผลิต/ }));

		expect(editorUiStore.workspaceMode).toBe("team");
		expect(projectStore.project?.productionMode).toBe("team");
		expect(projectStore.getBatchExportGate([0]).firstHoldReason).toBe("page review approval not recorded");
		expect(within(modeStrip).getByRole("button", { name: /ทีมผลิต/ }).getAttribute("aria-pressed")).toBe("true");
		expect(within(modeStrip).getByText("กำลังดู คนคลีน")).toBeTruthy();
		expect(screen.getByRole("region", { name: "ทีมผลิตแยกบทบาท" })).toBeTruthy();

		await fireEvent.click(within(modeStrip).getByRole("button", { name: /ทำคนเดียว/ }));

		expect(editorUiStore.workspaceMode).toBe("solo");
		expect(projectStore.project?.productionMode).toBe("solo");
		expect(projectStore.getBatchExportGate([0]).firstHoldReason).not.toBe("page review approval not recorded");
		expect(screen.queryByRole("region", { name: "ทีมผลิตแยกบทบาท" })).toBeNull();
	});

	it("counts page-state backlog on Team role cards and next work when explicit lane tasks are empty", async () => {
		const state = project();
		state.tasks = [];
		state.comments = [];
		state.creditPolicy = "optional";
		state.pages = [
			{
				imageId: "image-clean",
				imageName: "needs-clean.png",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
			},
			{
				imageId: "image-translate",
				imageName: "needs-translation.png",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
				cleaningHandoff: {
					status: "clean_ready",
					updatedAt: now,
					updatedBy: "cleaner",
				},
			},
			{
				imageId: "image-typeset",
				imageName: "needs-typeset.png",
				textLayers: [],
				pendingAiJobs: [],
				coverRect: null,
				cleaningHandoff: {
					status: "clean_ready",
					updatedAt: now,
					updatedBy: "cleaner",
				},
				translationHandoff: {
					status: "translated",
					updatedAt: now,
					updatedBy: "translator",
				},
				translationScriptSlots: [{
					id: "dialogue-1",
					label: "คำพูด 1",
					x: 18,
					y: 28,
					category: "dialogue",
					translatedText: "พร้อมไทป์เซ็ต",
					updatedAt: now,
				}],
			},
			{
				imageId: "image-qc",
				imageName: "needs-qc.png",
				textLayers: [{
					id: "layer-qc",
					text: "พร้อมรีวิว",
					name: "คำพูด 1",
					sourceProvider: "translation-slot:dialogue-1",
					sourceCategory: "dialogue",
					sourceText: "",
				} as any],
				pendingAiJobs: [],
				coverRect: null,
				cleaningHandoff: {
					status: "clean_ready",
					typesetRecheckStatus: "pending",
					updatedAt: now,
					updatedBy: "cleaner",
				},
				translationHandoff: {
					status: "translated",
					updatedAt: now,
					updatedBy: "translator",
				},
				translationScriptSlots: [{
					id: "dialogue-1",
					label: "คำพูด 1",
					x: 18,
					y: 28,
					category: "dialogue",
					translatedText: "พร้อมรีวิว",
					updatedAt: now,
				}],
			},
		];
		projectStore.__setProjectForTesting(state);
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();
		vi.spyOn(projectStore, "qcReport", "get").mockReturnValue({
			issues: [],
			errorCount: 0,
			warningCount: 0,
			infoCount: 0,
			pageCount: 4,
			checkedAt: now,
		});

		render(WorkspaceWorkBoardView);

		const roleMap = screen.getByRole("region", { name: "ทีมผลิตแยกบทบาท" });
		const cleanerCard = within(roleMap).getByText("คนคลีน").closest("article") as HTMLElement;
		const translatorCard = within(roleMap).getByText("คนแปล").closest("article") as HTMLElement;
		const typesetterCard = within(roleMap).getByText("คนไทป์เซ็ต").closest("article") as HTMLElement;
		const qcCard = within(roleMap).getByText("QC / เครดิต").closest("article") as HTMLElement;
		expect(within(cleanerCard).getByText("1 หน้าต้องทำ")).toBeTruthy();
		expect(within(translatorCard).getByText("1 หน้าต้องทำ")).toBeTruthy();
		expect(within(typesetterCard).getByText("1 หน้าต้องทำ")).toBeTruthy();
		expect(within(qcCard).getByText("1 หน้าต้องทำ")).toBeTruthy();
		expect(within(roleMap).queryByText("ยังไม่มีงาน")).toBeNull();

		// With the workflow-preset chooser removed, the page-state next strip no
		// longer narrows to a single role. It surfaces the earliest pending role
		// across the whole chapter (cleaner on page 1) so the full per-page detail
		// stays visible regardless of any role abstraction.
		const roleNext = screen.getByRole("region", { name: "งานถัดไปของโหมดที่เลือก" });
		expect(within(roleNext).getByText("งานจากสถานะหน้า")).toBeTruthy();
		expect(within(roleNext).getByText("คลีน หน้า 1")).toBeTruthy();
		expect(within(roleNext).getByText("จากสถานะหน้า / needs-clean.png / ถัดไป: คนคลีน")).toBeTruthy();
		expect(within(roleNext).queryByText(/ไม่มีงานค้าง/)).toBeNull();
		await fireEvent.click(within(roleNext).getByRole("button", { name: "เปิดหน้า 1" }));
		await waitFor(() => expect(projectStore.project?.currentPage).toBe(0));
		expect(screen.getByRole("region", { name: "ส่งงานคลีน" })).toBeTruthy();
	});

	it("uses the topbar Team mode, not the role preset, to restore team work board rails", async () => {
		const state = project();
		state.tasks[0].assignee = "solo";
		// Real translator slots placed on page 1 — the bench shows ONLY real slots
		// (no fabricated sample pins), so this workflow seeds the two it operates on.
		state.pages[0].translationScriptSlots = [
			{ id: "dialogue-1", label: "คำพูด 1", x: 18, y: 28, category: "dialogue", translatedText: "", updatedAt: now },
			{ id: "dialogue-2", label: "คำพูด 2", x: 64, y: 42, category: "dialogue", translatedText: "", updatedAt: now },
		];
		projectStore.__setProjectForTesting(state);
		projectStore.localImageUrls = {
			"image-1": "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
		};
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();

		render(WorkspaceWorkBoardView);

		expect(screen.getByText("งานผลิต")).toBeTruthy();
		const roleMap = screen.getByRole("region", { name: "ทีมผลิตแยกบทบาท" });
		expect(within(roleMap).getByText("คนคลีน")).toBeTruthy();
		expect(within(roleMap).getByText("คนแปล")).toBeTruthy();
		expect(within(roleMap).getByText("คนไทป์เซ็ต")).toBeTruthy();
		expect(within(roleMap).getByText("QC / เครดิต")).toBeTruthy();
		expect(within(roleMap).getByRole("button", { name: "เลือกบทบาท คนคลีน" }).textContent).toContain("เปิด คนคลีน");
		expect(within(roleMap).getByRole("button", { name: "เลือกบทบาท คนแปล" }).textContent).toContain("เปิด คนแปล");
		expect(within(roleMap).getByRole("button", { name: "เลือกบทบาท คนไทป์เซ็ต" }).textContent).toContain("เปิด คนไทป์เซ็ต");
		expect(within(roleMap).getByRole("button", { name: "เลือกบทบาท QC / เครดิต" }).textContent).toContain("เปิด QC / เครดิต");
		expect(within(roleMap).queryByText("ล้างคำบนรูปต้นฉบับ แล้วส่งหน้าหรือทั้งเรื่องกลับโปรเจกต์หลัก")).toBeNull();
		expect(within(roleMap).queryByText("อ่านรูปต้นฉบับ จิ้มตำแหน่งคำ และเขียนคำแปลข้างรูปเป็นหลายบรรทัดได้")).toBeNull();
		expect(within(roleMap).queryByText("วางข้อความบนไฟล์ raw ได้ก่อนงานคลีนเสร็จ แล้ว sync กับภาพคลีนเมื่อพร้อม")).toBeNull();
		expect(within(roleMap).getByLabelText("เลือกบทบาททีม")).toBeTruthy();
		const currentPageHandoffBeforeGrid = screen.getByRole("region", { name: "ส่งต่อหน้าปัจจุบันของทีม" });
		const roleGrid = roleMap.querySelector(".production-role-grid");
		expect(roleGrid).toBeTruthy();
		expect(Boolean(currentPageHandoffBeforeGrid.compareDocumentPosition(roleGrid!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
		const pageHandoff = screen.getByRole("region", { name: "สถานะงานแยกหน้าสำหรับทีม" });
		expect(within(pageHandoff).getByText("ดูสถานะรายหน้า")).toBeTruthy();
		expect(within(pageHandoff).getByText("เปิดเมื่ออยากเทียบคลีน แปล ไทป์เซ็ต และ QC ของแต่ละหน้า")).toBeTruthy();
		expect(pageHandoff.hasAttribute("open")).toBe(false);
		await fireEvent.click(within(pageHandoff).getByText("ดูสถานะรายหน้า"));
		expect(pageHandoff.hasAttribute("open")).toBe(true);
		expect(within(pageHandoff).getByText("P1")).toBeTruthy();
		expect(within(pageHandoff).getByText("P2")).toBeTruthy();
		expect(within(pageHandoff).getAllByText(/ถัดไป: คนคลีน/).length).toBeGreaterThan(0);
		const mainHandoff = screen.getByRole("region", { name: "ส่งกลับโปรเจกต์หลักของทีม" });
		expect(within(mainHandoff).getByText(/จุดก่อนส่งกลับโปรเจกต์หลัก/)).toBeTruthy();
		expect(within(mainHandoff).getByText("คลีน · 2 หน้ายังไม่คลีน")).toBeTruthy();
		expect(within(mainHandoff).getByRole("button", { name: "ไปคนคลีน" })).toBeTruthy();
		expect(screen.getAllByText("รอแยกเข้าทีม").length).toBeGreaterThan(0);
		expect(screen.queryByText("โหมด Solo")).toBeNull();
		await fireEvent.click(within(pageHandoff).getByRole("button", { name: "เปิด P2" }));
		expect(projectStore.project?.currentPage).toBe(1);
		expect(within(roleMap).getByText("คนคลีน").closest("article")?.className).toContain("active");
		await fireEvent.click(within(pageHandoff).getByRole("button", { name: "เปิด P1" }));
		expect(projectStore.project?.currentPage).toBe(0);
		await fireEvent.click(within(roleMap).getByRole("button", { name: "เลือกบทบาท คนคลีน" }));
		const cleanerHandoff = screen.getByRole("region", { name: "ส่งงานคลีน" });
		expect(within(cleanerHandoff).getByText("ยังเป็น raw / รอคลีน")).toBeTruthy();
		expect(within(cleanerHandoff).getByText("ยังไม่มีหลักฐานแปรงคลีน")).toBeTruthy();
		expect(within(cleanerHandoff).getByText("ยังไม่ส่งภาพคลีน แต่ไม่บล็อกสคริปต์/ไทป์เซ็ตต้นทาง")).toBeTruthy();
		await fireEvent.click(within(cleanerHandoff).getByRole("button", { name: "ยืนยันว่าไม่ต้องคลีน" }));
		expect(projectStore.project?.pages[0]?.cleaningHandoff).toMatchObject({
			status: "clean_ready",
			updatedBy: "cleaner",
			proofKind: "no-clean-needed",
			proofLabel: "ยืนยันว่าไม่ต้องคลีนหน้านี้",
		});
		expect(within(cleanerHandoff).getByText("พร้อมให้ไทป์เซ็ต")).toBeTruthy();
		expect(within(cleanerHandoff).getByText("ยืนยันว่าไม่ต้องคลีน")).toBeTruthy();
		expect(within(cleanerHandoff).getByText("คนไทป์เซ็ตใช้ภาพคลีนตรวจตำแหน่งได้")).toBeTruthy();
		expect(projectStore.saveSyncStatus).toBe("unsaved");
		const currentPageHandoff = screen.getByRole("region", { name: "ส่งต่อหน้าปัจจุบันของทีม" });
		expect(within(currentPageHandoff).getByText("P1 · ถัดไป: คนแปล")).toBeTruthy();
		await fireEvent.click(within(currentPageHandoff).getByRole("button", { name: "ไปคนแปล" }));
		expect(within(roleMap).getByText("คนแปล").closest("article")?.className).toContain("active");
		const translatorBench = screen.getByRole("region", { name: "โต๊ะแปลข้างรูป" });
		expect(within(translatorBench).getByText("รูปต้นฉบับ + สคริปต์ข้างรูป")).toBeTruthy();
		expect(within(translatorBench).getByText(/EN \/ หน้า 1 · 0\/2 ช่องมีคำแปล/)).toBeTruthy();
		const firstScript = within(translatorBench).getByRole("textbox", { name: "คำพูด 1 คำแปล" }) as HTMLTextAreaElement;
		expect(firstScript.value).toBe("");
		expect(within(translatorBench).queryByRole("button", { name: "ส่งหน้านี้ให้ไทป์เซ็ต" })).toBeNull();
		await fireEvent.input(firstScript, { target: { value: "บรรทัดหนึ่ง\nบรรทัดสอง" } });
		expect(projectStore.project?.pages[0]?.translationScriptSlots?.[0]).toMatchObject({
			id: "dialogue-1",
			label: "คำพูด 1",
			x: 18,
			y: 28,
			translatedText: "บรรทัดหนึ่ง\nบรรทัดสอง",
		});
		expect(projectStore.saveSyncStatus).toBe("unsaved");
		await fireEvent.click(within(translatorBench).getByRole("button", { name: "เลือกตำแหน่งแปล คำพูด 2" }));
		expect(within(translatorBench).getByText(/กำลังวาง:/).textContent).toContain("คำพูด 2");
		const placementTarget = translatorBench.querySelector(".translator-placement-target") as HTMLElement;
		vi.spyOn(placementTarget, "getBoundingClientRect").mockReturnValue({
			x: 50,
			y: 25,
			left: 50,
			top: 25,
			right: 250,
			bottom: 125,
			width: 200,
			height: 100,
			toJSON: () => ({}),
		} as DOMRect);
		await fireEvent.click(placementTarget, { clientX: 150, clientY: 75 });
		expect(projectStore.project?.pages[0]?.translationScriptSlots).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: "dialogue-2",
				x: 50,
				y: 50,
			}),
		]));
		await fireEvent.click(within(translatorBench).getByRole("button", { name: "เพิ่มช่องแปล" }));
		expect(within(translatorBench).getByText(/กำลังวาง:/).textContent).toContain("ช่องแปล 3");
		const customName = within(translatorBench).getByRole("textbox", { name: /ชื่อช่องแปล ช่องแปล 3/ }) as HTMLInputElement;
		await fireEvent.input(customName, { target: { value: "เสียงกรีด" } });
		expect(projectStore.project?.pages[0]?.translationScriptSlots).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: "custom-0-3",
				label: "เสียงกรีด",
				x: 50,
				y: 50,
				updatedBy: "translator",
			}),
		]));
		// Every real slot is deletable now (no fabricated "default" slots are locked).
		const customCard = customName.closest(".translator-script-card") as HTMLElement;
		await fireEvent.click(within(customCard).getByRole("button", { name: "ลบช่อง" }));
		expect(projectStore.project?.pages[0]?.translationScriptSlots?.some((slot) => slot.id === "custom-0-3")).toBe(false);
		expect(within(translatorBench).getByText("มีร่างคำแปล ยังไม่ส่งต่อ")).toBeTruthy();
		await fireEvent.click(within(translatorBench).getByRole("button", { name: "ส่งหน้านี้ให้ไทป์เซ็ต" }));
		expect(projectStore.project?.pages[0]?.translationHandoff).toMatchObject({
			status: "translated",
			updatedBy: "translator",
		});
		expect(projectStore.statusMsg).toBe("ส่งสคริปต์แปลหน้านี้ให้ไทป์เซ็ตแล้ว");
		expect(within(translatorBench).getByText("ส่งให้ไทป์เซ็ตแล้ว")).toBeTruthy();
		expect(within(currentPageHandoff).getByText("P1 · ถัดไป: คนไทป์เซ็ต")).toBeTruthy();
		await fireEvent.click(within(currentPageHandoff).getByRole("button", { name: "ไปคนไทป์เซ็ต" }));
		const typesetterBench = screen.getByRole("region", { name: "ไทป์เซ็ตจากสคริปต์แปล" });
		expect(within(typesetterBench).getByText("หน้า 1 / EN · ภาพคลีนพร้อม")).toBeTruthy();
		expect(within(typesetterBench).getByText(/ภาพคลีนพร้อม/)).toBeTruthy();
		expect(within(typesetterBench).getByText("ใช้ภาพคลีนเป็นฐานตรวจตำแหน่ง")).toBeTruthy();
		expect(within(typesetterBench).getAllByText("สร้างบนคลีน-ready").length).toBeGreaterThan(0);
		const dialogueCard = within(typesetterBench).getByText(/คำพูด 1 · ตำแหน่ง/).closest(".typesetter-script-card") as HTMLElement;
		expect(within(dialogueCard).getByRole("button", { name: "สร้างกล่อง คำพูด 1 บน หน้า 1 ภาษา EN แล้วเปิดหน้า" })).toBeTruthy();
		expect(within(dialogueCard).queryByRole("button", { name: "สร้างและเปิดหน้าแก้" })).toBeNull();
		await fireEvent.click(within(dialogueCard).getByRole("button", { name: "สร้างกล่อง คำพูด 1 บน หน้า 1 ภาษา EN แล้วเปิดหน้า" }));
		expect(projectStore.project?.pages[0]?.textLayers).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: "typeset-dialogue-1",
				name: "คำพูด 1",
				sourceProvider: "translation-slot:dialogue-1",
				text: "บรรทัดหนึ่ง\nบรรทัดสอง",
			}),
		]));
		expect(projectStore.project?.pages[0]?.cleaningHandoff?.typesetRecheckStatus).toBe("pending");
		expect(projectStore.project?.pages[0]?.cleaningHandoff?.typesetRecheckUpdatedBy).toBe("typesetter");
		expect(editorUiStore.workspaceView).toBe("editor");
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.textInspectorFocusLayerId).toBe("typeset-dialogue-1");
	});

	it("sends cleaner handoff with brush proof when a cleaned image layer exists", async () => {
		const state = project();
		state.comments = [];
		state.pages[0].imageLayers = [{
			id: "clean-layer-1",
			name: "คลีนบับเบิลหน้า 1",
			imageId: "cleaned-page-1",
			imageName: "cleaned-page-1.png",
			restoreImageId: "raw-page-1",
			x: 0,
			y: 0,
			w: 900,
			h: 1350,
			rotation: 0,
			opacity: 1,
			index: 0,
			role: "overlay",
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openWorkBoard();
		editorUiStore.setWorkspaceMode("team");

		render(WorkspaceWorkBoardView);
		const roleMap = screen.getByRole("region", { name: "ทีมผลิตแยกบทบาท" });
		await fireEvent.click(within(roleMap).getByRole("button", { name: "เลือกบทบาท คนคลีน" }));
		const cleanerHandoff = screen.getByRole("region", { name: "ส่งงานคลีน" });

		expect(within(cleanerHandoff).getByText("คลีนบับเบิลหน้า 1")).toBeTruthy();
		await fireEvent.click(within(cleanerHandoff).getByRole("button", { name: "ส่งพร้อมหลักฐานแปรง" }));

		expect(projectStore.project?.pages[0]?.cleaningHandoff).toMatchObject({
			status: "clean_ready",
			proofKind: "brush-edited-layer",
			proofLayerId: "clean-layer-1",
			proofLabel: "คลีนบับเบิลหน้า 1",
		});
		expect(projectStore.statusMsg).toBe("ส่งงานคลีนพร้อมหลักฐานแปรงให้ทีมไทป์เซ็ตแล้ว");
	});

	it("returns translated pages to draft when the translator edits a sent script", async () => {
		const state = project();
		state.pages[0].cleaningHandoff = {
			status: "clean_ready",
			updatedAt: now,
			updatedBy: "cleaner",
		};
		state.pages[0].translationHandoff = {
			status: "translated",
			updatedAt: now,
			updatedBy: "translator",
		};
		state.pages[0].qcHandoff = {
			status: "ready",
			updatedAt: now,
			updatedBy: "qc",
		};
		state.pages[0].translationScriptSlots = [{
			id: "dialogue-1",
			label: "คำพูด 1",
			x: 18,
			y: 28,
			category: "dialogue",
			translatedText: "ส่งแล้ว",
			updatedAt: now,
		}];
		projectStore.__setProjectForTesting(state);
		projectStore.localImageUrls = {
			"image-1": "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
		};
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();

		render(WorkspaceWorkBoardView);

		const roleMap = screen.getByRole("region", { name: "ทีมผลิตแยกบทบาท" });
		await fireEvent.click(within(roleMap).getByRole("button", { name: "เลือกบทบาท คนแปล" }));
		const translatorBench = screen.getByRole("region", { name: "โต๊ะแปลข้างรูป" });
		expect(within(translatorBench).getByText("ส่งให้ไทป์เซ็ตแล้ว")).toBeTruthy();

		const firstScript = within(translatorBench).getByRole("textbox", { name: "คำพูด 1 คำแปล" }) as HTMLTextAreaElement;
		await fireEvent.input(firstScript, { target: { value: "แก้หลังส่ง" } });

		expect(projectStore.project?.pages[0]?.translationHandoff?.status).toBe("draft");
		expect(projectStore.project?.pages[0]?.qcHandoff?.status).toBe("pending");
		expect(within(translatorBench).getByText("มีร่างคำแปล ยังไม่ส่งต่อ")).toBeTruthy();
		const currentPageHandoff = screen.getByRole("region", { name: "ส่งต่อหน้าปัจจุบันของทีม" });
		expect(within(currentPageHandoff).getByText("P1 · ถัดไป: คนแปล")).toBeTruthy();
	});

	it("shows an honest empty bench (no fabricated slots) then persists real slots the translator adds", async () => {
		const state = project();
		state.pages[0].cleaningHandoff = {
			status: "clean_ready",
			updatedAt: now,
			updatedBy: "cleaner",
		};
		state.pages[0].translationScriptSlots = [];
		projectStore.__setProjectForTesting(state);
		projectStore.localImageUrls = {
			"image-1": "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
		};
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();

		render(WorkspaceWorkBoardView);

		const roleMap = screen.getByRole("region", { name: "ทีมผลิตแยกบทบาท" });
		await fireEvent.click(within(roleMap).getByRole("button", { name: "เลือกบทบาท คนแปล" }));
		const translatorBench = screen.getByRole("region", { name: "โต๊ะแปลข้างรูป" });
		// No fabricated sample pins/cards on a page with no real slots — honest empty state.
		expect(within(translatorBench).getByText("ยังไม่มีช่องแปลบนหน้านี้")).toBeTruthy();
		expect(within(translatorBench).queryByRole("textbox", { name: "คำพูด 1 คำแปล" })).toBeNull();
		expect(within(translatorBench).getByText(/หน้า 1 · 0\/0 ช่องมีคำแปล/)).toBeTruthy();

		// The translator adds a real slot, then it appears as a real card to type into.
		await fireEvent.click(within(translatorBench).getByRole("button", { name: "เพิ่มช่องแปล" }));
		expect(within(translatorBench).queryByText("ยังไม่มีช่องแปลบนหน้านี้")).toBeNull();
		const firstScript = within(translatorBench).getByRole("textbox", { name: /ช่องแปล 1 คำแปล/ }) as HTMLTextAreaElement;
		expect(firstScript.value).toBe("");
		await fireEvent.input(firstScript, { target: { value: "บรรทัดแรก\nบรรทัดสอง" } });
		await fireEvent.click(within(translatorBench).getByRole("button", { name: "ส่งหน้านี้ให้ไทป์เซ็ต" }));

		expect(projectStore.project?.pages[0]?.translationScriptSlots).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: "custom-0-1",
				label: "ช่องแปล 1",
				translatedText: "บรรทัดแรก\nบรรทัดสอง",
			}),
		]));
		expect(projectStore.project?.pages[0]?.translationHandoff?.status).toBe("translated");
		const currentPageHandoff = screen.getByRole("region", { name: "ส่งต่อหน้าปัจจุบันของทีม" });
		expect(within(currentPageHandoff).getByText("แปล · 1 ช่องพร้อมส่ง")).toBeTruthy();
	});

	it("routes translated pages with no script back to the translator", async () => {
		const state = project();
		state.pages[0].cleaningHandoff = {
			status: "clean_ready",
			updatedAt: now,
			updatedBy: "cleaner",
		};
		state.pages[0].translationHandoff = {
			status: "translated",
			updatedAt: now,
			updatedBy: "translator",
		};
		state.pages[0].translationScriptSlots = [];
		projectStore.__setProjectForTesting(state);
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();

		render(WorkspaceWorkBoardView);

		const currentPageHandoff = screen.getByRole("region", { name: "ส่งต่อหน้าปัจจุบันของทีม" });
		expect(within(currentPageHandoff).getByText("P1 · ถัดไป: คนแปลเติมสคริปต์")).toBeTruthy();
		expect(within(currentPageHandoff).getByText("แปล · ไม่มีสคริปต์พร้อมส่ง")).toBeTruthy();
		expect(within(currentPageHandoff).queryByText("แปล · 0 ช่องพร้อมส่ง")).toBeNull();
	});

	it("does not reconcile translate tasks when translated status has no script", async () => {
		const state = project();
		state.tasks = [{
			id: "task-translate-empty",
			type: "translate",
			status: "review",
			priority: "normal",
			pageIndex: 0,
			title: "Translate page 1",
			createdAt: now,
			updatedAt: now,
		}];
		state.pages[0].cleaningHandoff = {
			status: "clean_ready",
			updatedAt: now,
			updatedBy: "cleaner",
		};
		state.pages[0].translationHandoff = {
			status: "translated",
			updatedAt: now,
			updatedBy: "translator",
		};
		state.pages[0].translationScriptSlots = [];
		projectStore.__setProjectForTesting(state);
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();

		render(WorkspaceWorkBoardView);

		expect(screen.queryByRole("region", { name: "ปรับคิวงานตามสถานะหน้าจริง" })).toBeNull();
		expect(projectStore.tasks.find((task) => task.id === "task-translate-empty")?.status).toBe("review");
		const currentPageHandoff = screen.getByRole("region", { name: "ส่งต่อหน้าปัจจุบันของทีม" });
		expect(within(currentPageHandoff).getByText("แปล · ไม่มีสคริปต์พร้อมส่ง")).toBeTruthy();
	});

	it("routes main-project handoff to QC when only QC blockers remain", async () => {
		const state = project();
		state.pages = state.pages.map((page, pageIndex) => ({
			...page,
			translationScriptSlots: [{
				id: `dialogue-${pageIndex + 1}`,
				label: "คำพูด",
				x: 20,
				y: 30,
				category: "dialogue",
				translatedText: "พร้อม QC",
				updatedAt: now,
			}],
			translationHandoff: {
				status: "translated",
				updatedAt: now,
				updatedBy: "translator",
			},
			cleaningHandoff: {
				status: "clean_ready",
				updatedAt: now,
				updatedBy: "cleaner",
				typesetRecheckStatus: "verified",
				typesetRecheckUpdatedAt: now,
				typesetRecheckUpdatedBy: "qc",
			},
			textLayers: [{
				id: `typeset-dialogue-${pageIndex + 1}`,
				name: "คำพูด",
				text: "พร้อม QC",
				sourceCategory: "dialogue",
				sourceProvider: `translation-slot:dialogue-${pageIndex + 1}`,
				x: 20,
				y: 30,
				w: 240,
				h: 80,
				rotation: 0,
				fontSize: 28,
				alignment: "center",
				index: 0,
			}],
		}));
		projectStore.__setProjectForTesting(state);
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();
		vi.spyOn(projectStore, "qcReport", "get").mockReturnValue({
			issues: [],
			errorCount: 0,
			warningCount: 0,
			infoCount: 0,
			pageCount: 2,
			checkedAt: now,
		});

		render(WorkspaceWorkBoardView);

		const mainHandoff = screen.getByRole("region", { name: "ส่งกลับโปรเจกต์หลักของทีม" });
		expect(within(mainHandoff).getByText(/QC · .*งาน QC ค้าง/)).toBeTruthy();
		await fireEvent.click(within(mainHandoff).getByRole("button", { name: "ไป QC / เครดิต" }));

		expect(projectStore.project?.currentPage).toBe(0);
		const roleMap = screen.getByRole("region", { name: "ทีมผลิตแยกบทบาท" });
		expect(within(roleMap).getByText("QC / เครดิต").closest("article")?.className).toContain("active");
	});

	it("shows pending clean/typeset recheck as a QC action instead of a clear queue", async () => {
		const state = project();
		state.tasks = [];
		state.comments = [];
		state.pages[0].cleaningHandoff = {
			status: "clean_ready",
			updatedAt: now,
			updatedBy: "cleaner",
			typesetRecheckStatus: "pending",
			typesetRecheckUpdatedAt: now,
			typesetRecheckUpdatedBy: "typesetter",
		};
		state.pages[0].translationScriptSlots = [{
			id: "dialogue-1",
			label: "คำพูด 1",
			x: 18,
			y: 28,
			category: "dialogue",
			translatedText: "ตรวจตำแหน่งนี้",
			updatedAt: now,
		}];
		state.pages[0].textLayers = [{
			id: "typeset-dialogue-1",
			name: "คำพูด 1",
			text: "ตรวจตำแหน่งนี้",
			sourceCategory: "dialogue",
			sourceProvider: "translation-slot:dialogue-1",
			x: 20,
			y: 30,
			w: 240,
			h: 80,
			rotation: 0,
			fontSize: 28,
			alignment: "center",
			index: 0,
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();
		vi.spyOn(projectStore, "qcReport", "get").mockReturnValue({
			issues: [],
			errorCount: 0,
			warningCount: 0,
			infoCount: 0,
			pageCount: 2,
			checkedAt: now,
		});

		render(WorkspaceWorkBoardView);

		const roleMap = screen.getByRole("region", { name: "ทีมผลิตแยกบทบาท" });
		await fireEvent.click(within(roleMap).getByRole("button", { name: "เลือกบทบาท QC / เครดิต" }));
		const qcBench = screen.getByRole("region", { name: "QC / เครดิต" });
		expect(within(qcBench).getByText("ตรวจคลีน/ไทป์เซ็ตก่อนส่งต่อ")).toBeTruthy();
		expect(within(qcBench).queryByText("คิวตรวจเคลียร์แล้ว")).toBeNull();

		await fireEvent.click(within(qcBench).getByRole("button", { name: "ยืนยันตรวจคลีนแล้ว" }));

		expect(projectStore.project?.pages[0]?.cleaningHandoff?.typesetRecheckStatus).toBe("verified");
		expect(within(qcBench).getByText("คิวตรวจเคลียร์แล้ว")).toBeTruthy();
	});

	it("requires an explicit final QC handoff before the team can return the chapter", async () => {
		const state = project();
		state.tasks = [];
		state.comments = [];
		state.pages = [state.pages[0]];
		state.pages[0].translationScriptSlots = [{
			id: "dialogue-1",
			label: "คำพูด 1",
			x: 18,
			y: 28,
			category: "dialogue",
			translatedText: "พร้อมส่งท้าย",
			updatedAt: now,
		}];
		state.pages[0].translationHandoff = {
			status: "translated",
			updatedAt: now,
			updatedBy: "translator",
		};
		state.pages[0].cleaningHandoff = {
			status: "clean_ready",
			updatedAt: now,
			updatedBy: "cleaner",
			typesetRecheckStatus: "verified",
			typesetRecheckUpdatedAt: now,
			typesetRecheckUpdatedBy: "qc",
		};
		state.pages[0].textLayers = [{
			id: "typeset-dialogue-1",
			name: "คำพูด 1",
			text: "พร้อมส่งท้าย",
			sourceCategory: "dialogue",
			sourceProvider: "translation-slot:dialogue-1",
			x: 20,
			y: 30,
			w: 240,
			h: 80,
			rotation: 0,
			fontSize: 28,
			alignment: "center",
			index: 0,
		}];
		state.reviewDecisions = [{
			id: "review-decision-approved",
			pageIndex: 0,
			status: "approved",
			body: "ผ่านรีวิวหน้าแล้ว",
			actor: "QC",
			createdAt: now,
			updatedAt: now,
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();
		vi.spyOn(projectStore, "qcReport", "get").mockReturnValue({
			issues: [],
			errorCount: 0,
			warningCount: 0,
			infoCount: 0,
			pageCount: 1,
			checkedAt: now,
		});

		render(WorkspaceWorkBoardView);

		const currentPageHandoff = screen.getByRole("region", { name: "ส่งต่อหน้าปัจจุบันของทีม" });
		expect(within(currentPageHandoff).getByText("QC · รอปิด QC")).toBeTruthy();
		const mainHandoff = screen.getByRole("region", { name: "ส่งกลับโปรเจกต์หลักของทีม" });
		expect(within(mainHandoff).getByText("QC · 1 หน้ารอปิด QC")).toBeTruthy();
		await fireEvent.click(within(mainHandoff).getByRole("button", { name: "ไปปิด QC" }));

		const roleMap = screen.getByRole("region", { name: "ทีมผลิตแยกบทบาท" });
		expect(within(roleMap).getByText("QC / เครดิต").closest("article")?.className).toContain("active");
		const qcBench = screen.getByRole("region", { name: "QC / เครดิต" });
		expect(within(qcBench).getAllByText("รอปิด QC").length).toBeGreaterThan(0);
		await fireEvent.click(within(qcBench).getByRole("button", { name: "ปิด QC หน้านี้" }));

		expect(projectStore.project?.pages[0]?.qcHandoff).toMatchObject({
			status: "ready",
			updatedBy: "qc",
		});
		expect(within(currentPageHandoff).getByText("QC · ปิด QC แล้ว")).toBeTruthy();
		expect(within(mainHandoff).getByText("พร้อมส่งกลับโปรเจกต์หลัก")).toBeTruthy();
		expect(within(mainHandoff).getByText("QC · QC ปิดครบ")).toBeTruthy();

		await fireEvent.click(within(qcBench).getByRole("button", { name: "เผยแพร่/ส่งออก ต้องมี" }));

		expect(projectStore.project?.creditPolicy).toBe("required");
		expect(within(mainHandoff).getByText("1 จุดก่อนส่งกลับโปรเจกต์หลัก")).toBeTruthy();
		expect(within(mainHandoff).getByText("เครดิต · Export ต้องมีเครดิต")).toBeTruthy();
		expect(within(mainHandoff).getByRole("button", { name: "ไปเครดิต" })).toBeTruthy();
		expect(within(qcBench).getByText("เป้าส่งออก เผยแพร่/ส่งออก: ต้องเพิ่มเครดิตอย่างน้อย 1 รายการก่อนส่งกลับโปรเจกต์หลัก")).toBeTruthy();
		await fireEvent.click(within(qcBench).getByRole("button", { name: "ร่าง/ภายใน ไม่บังคับ" }));

		expect(projectStore.project?.creditPolicy).toBe("optional");
		expect(within(mainHandoff).getByText("พร้อมส่งกลับโปรเจกต์หลัก")).toBeTruthy();
		expect(within(mainHandoff).getByText("เครดิต · Draft ไม่บังคับ")).toBeTruthy();

		await fireEvent.click(within(qcBench).getByRole("button", { name: "เปิดกลับตรวจ" }));

		expect(projectStore.project?.pages[0]?.qcHandoff?.status).toBe("needs_fix");
		expect(within(currentPageHandoff).getByText("QC · ส่งกลับแก้")).toBeTruthy();
		expect(within(mainHandoff).getByText("QC · 1 หน้ารอปิด QC")).toBeTruthy();
	});

	it("blocks final QC close until Focus has an approved review decision", async () => {
		const state = project();
		state.tasks = [];
		state.comments = [];
		state.reviewDecisions = [];
		state.pages = [state.pages[0]];
		state.pages[0].translationScriptSlots = [{
			id: "dialogue-1",
			label: "คำพูด 1",
			x: 18,
			y: 28,
			category: "dialogue",
			translatedText: "พร้อมส่งท้าย",
			updatedAt: now,
		}];
		state.pages[0].translationHandoff = {
			status: "translated",
			updatedAt: now,
			updatedBy: "translator",
		};
		state.pages[0].cleaningHandoff = {
			status: "clean_ready",
			updatedAt: now,
			updatedBy: "cleaner",
			typesetRecheckStatus: "verified",
			typesetRecheckUpdatedAt: now,
			typesetRecheckUpdatedBy: "qc",
		};
		state.pages[0].textLayers = [{
			id: "typeset-dialogue-1",
			name: "คำพูด 1",
			text: "พร้อมส่งท้าย",
			sourceCategory: "dialogue",
			sourceProvider: "translation-slot:dialogue-1",
			x: 20,
			y: 30,
			w: 240,
			h: 80,
			rotation: 0,
			fontSize: 28,
			alignment: "center",
			index: 0,
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();
		vi.spyOn(projectStore, "qcReport", "get").mockReturnValue({
			issues: [],
			errorCount: 0,
			warningCount: 0,
			infoCount: 0,
			pageCount: 1,
			checkedAt: now,
		});

		render(WorkspaceWorkBoardView);

		const currentPageHandoff = screen.getByRole("region", { name: "ส่งต่อหน้าปัจจุบันของทีม" });
		expect(within(currentPageHandoff).getByText("P1 · ถัดไป: QC ตรวจหน้า")).toBeTruthy();
		expect(within(currentPageHandoff).getByText("QC · รอผลรีวิว")).toBeTruthy();
		const mainHandoff = screen.getByRole("region", { name: "ส่งกลับโปรเจกต์หลักของทีม" });
		expect(within(mainHandoff).getByText("QC · 1 หน้ารอผลรีวิว")).toBeTruthy();
		await fireEvent.click(within(mainHandoff).getByRole("button", { name: "ไปตรวจหน้า" }));

		const qcBench = screen.getByRole("region", { name: "QC / เครดิต" });
		expect(within(qcBench).getByText("รอผลรีวิวหน้า")).toBeTruthy();
		expect(within(qcBench).getByText("หน้านี้พร้อมรีวิวขั้นสุดท้าย แต่ยังไม่มีผลรีวิวผ่าน จึงยังปิด QC หรือ Export ไม่ได้")).toBeTruthy();
		expect(within(qcBench).queryByRole("button", { name: "ปิด QC หน้านี้" })).toBeNull();

		// Focus mode was removed: "รีวิวงานนี้" now opens the editor with the review
		// task selected in the contextual Work panel (and still creates the task).
		await fireEvent.click(within(qcBench).getByRole("button", { name: "รีวิวงานนี้" }));

		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		expect(editorUiStore.rightPanelMode).toBe("work");
		expect(projectStore.tasks).toEqual([
			expect.objectContaining({
				type: "review",
				status: "review",
				pageIndex: 0,
				title: "ตรวจหน้า 1 ก่อน Export",
			}),
		]);
		expect(projectStore.project?.pages[0]?.qcHandoff?.status).toBeUndefined();
	});

	it("keeps QC truth grid from claiming typeset is matched before text boxes exist", async () => {
		const state = project();
		state.tasks = [];
		state.comments = [];
		state.pages = [state.pages[0]];
		state.pages[0].translationScriptSlots = [{
			id: "dialogue-1",
			label: "คำพูด 1",
			x: 18,
			y: 28,
			category: "dialogue",
			translatedText: "ยังไม่ได้วาง",
			updatedAt: now,
		}];
		state.pages[0].translationHandoff = {
			status: "translated",
			updatedAt: now,
			updatedBy: "translator",
		};
		state.pages[0].cleaningHandoff = {
			status: "clean_ready",
			updatedAt: now,
			updatedBy: "cleaner",
			typesetRecheckStatus: "pending",
			typesetRecheckUpdatedAt: now,
			typesetRecheckUpdatedBy: "typesetter",
		};
		state.pages[0].textLayers = [];
		projectStore.__setProjectForTesting(state);
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();
		vi.spyOn(projectStore, "qcReport", "get").mockReturnValue({
			issues: [],
			errorCount: 0,
			warningCount: 0,
			infoCount: 0,
			pageCount: 1,
			checkedAt: now,
		});

		render(WorkspaceWorkBoardView);

		const roleMap = screen.getByRole("region", { name: "ทีมผลิตแยกบทบาท" });
		await fireEvent.click(within(roleMap).getByRole("button", { name: "เลือกบทบาท QC / เครดิต" }));
		const qcBench = screen.getByRole("region", { name: "QC / เครดิต" });
		expect(within(qcBench).getByText("1 ช่องยังไม่ไทป์เซ็ต")).toBeTruthy();
		expect(within(qcBench).queryByText("ตรงกับสคริปต์")).toBeNull();
	});

	it("blocks final QC when any translated script slot has no text box", async () => {
		const state = project();
		state.tasks = [];
		state.comments = [];
		state.pages = [state.pages[0]];
		state.pages[0].translationScriptSlots = [
			{
				id: "dialogue-1",
				label: "คำพูด 1",
				x: 18,
				y: 28,
				category: "dialogue",
				translatedText: "ลงแล้ว",
				updatedAt: now,
			},
			{
				id: "dialogue-2",
				label: "คำพูด 2",
				x: 62,
				y: 40,
				category: "dialogue",
				translatedText: "ยังไม่ได้ลง",
				updatedAt: now,
			},
		];
		state.pages[0].translationHandoff = {
			status: "translated",
			updatedAt: now,
			updatedBy: "translator",
		};
		state.pages[0].cleaningHandoff = {
			status: "clean_ready",
			updatedAt: now,
			updatedBy: "cleaner",
			typesetRecheckStatus: "verified",
			typesetRecheckUpdatedAt: now,
			typesetRecheckUpdatedBy: "qc",
		};
		state.pages[0].textLayers = [{
			id: "typeset-dialogue-1",
			name: "คำพูด 1",
			text: "ลงแล้ว",
			sourceCategory: "dialogue",
			sourceProvider: "translation-slot:dialogue-1",
			x: 20,
			y: 30,
			w: 240,
			h: 80,
			rotation: 0,
			fontSize: 28,
			alignment: "center",
			index: 0,
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();
		vi.spyOn(projectStore, "qcReport", "get").mockReturnValue({
			issues: [],
			errorCount: 0,
			warningCount: 0,
			infoCount: 0,
			pageCount: 1,
			checkedAt: now,
		});

		render(WorkspaceWorkBoardView);

		const currentPageHandoff = screen.getByRole("region", { name: "ส่งต่อหน้าปัจจุบันของทีม" });
		expect(within(currentPageHandoff).getByText("P1 · ถัดไป: คนไทป์เซ็ต")).toBeTruthy();
		expect(within(currentPageHandoff).getByText("ไทป์เซ็ต · 1 ช่องยังไม่ไทป์เซ็ต")).toBeTruthy();
		const mainHandoff = screen.getByRole("region", { name: "ส่งกลับโปรเจกต์หลักของทีม" });
		expect(within(mainHandoff).getByText("ไทป์เซ็ต · 1 หน้ารอไทป์เซ็ต")).toBeTruthy();
		expect(within(mainHandoff).queryByText("พร้อมส่งกลับโปรเจกต์หลัก")).toBeNull();
	});

	it("routes a required-credit main handoff directly into the credit tools", async () => {
		const state = project();
		state.tasks = [];
		state.comments = [];
		state.creditPolicy = "required";
		state.pages = [state.pages[0]];
		state.pages[0].translationScriptSlots = [{
			id: "dialogue-1",
			label: "คำพูด 1",
			x: 18,
			y: 28,
			category: "dialogue",
			translatedText: "พร้อมส่งท้าย",
			updatedAt: now,
		}];
		state.pages[0].translationHandoff = {
			status: "translated",
			updatedAt: now,
			updatedBy: "translator",
		};
		state.pages[0].cleaningHandoff = {
			status: "clean_ready",
			updatedAt: now,
			updatedBy: "cleaner",
			typesetRecheckStatus: "verified",
			typesetRecheckUpdatedAt: now,
			typesetRecheckUpdatedBy: "qc",
		};
		state.pages[0].qcHandoff = {
			status: "ready",
			updatedAt: now,
			updatedBy: "qc",
		};
		state.pages[0].textLayers = [{
			id: "typeset-dialogue-1",
			name: "คำพูด 1",
			text: "พร้อมส่งท้าย",
			sourceCategory: "dialogue",
			sourceProvider: "translation-slot:dialogue-1",
			x: 20,
			y: 30,
			w: 240,
			h: 80,
			rotation: 0,
			fontSize: 28,
			alignment: "center",
			index: 0,
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();
		vi.spyOn(projectStore, "qcReport", "get").mockReturnValue({
			issues: [],
			errorCount: 0,
			warningCount: 0,
			infoCount: 0,
			pageCount: 1,
			checkedAt: now,
		});

		render(WorkspaceWorkBoardView);

		const mainHandoff = screen.getByRole("region", { name: "ส่งกลับโปรเจกต์หลักของทีม" });
		expect(within(mainHandoff).getByText("เครดิต · Export ต้องมีเครดิต")).toBeTruthy();
		const tokenBefore = editorUiStore.creditToolsFocusToken;
		await fireEvent.click(within(mainHandoff).getByRole("button", { name: "ไปเครดิต" }));

		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.creditToolsFocusToken).toBe(tokenBefore + 1);
		expect(projectStore.statusMsg).toBe("เปิดเครื่องมือเครดิตในแผงเลเยอร์แล้ว");
	});

	it("lets Team explicitly reconcile open tasks whose page-backed state is already complete", async () => {
		const state = project();
		state.comments = [];
		state.tasks = [
			{
				id: "task-clean-drift",
				type: "clean",
				status: "todo",
				priority: "normal",
				pageIndex: 0,
				title: "Clean page 1",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "task-typeset-drift",
				type: "typeset",
				status: "review",
				priority: "normal",
				pageIndex: 0,
				title: "Typeset page 1",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "task-translate-open",
				type: "translate",
				status: "todo",
				priority: "normal",
				pageIndex: 0,
				title: "Translate page 1",
				createdAt: now,
				updatedAt: now,
			},
		];
		state.pages[0].cleaningHandoff = {
			status: "clean_ready",
			updatedAt: now,
			updatedBy: "cleaner",
			typesetRecheckStatus: "verified",
			typesetRecheckUpdatedAt: now,
			typesetRecheckUpdatedBy: "qc",
		};
		state.pages[0].translationScriptSlots = [{
			id: "dialogue-1",
			label: "คำพูด 1",
			x: 18,
			y: 28,
			category: "dialogue",
			translatedText: "พร้อมแล้ว",
			updatedAt: now,
		}];
		state.pages[0].translationHandoff = {
			status: "translated",
			updatedAt: now,
			updatedBy: "translator",
		};
		state.pages[0].textLayers = [{
			id: "typeset-dialogue-1",
			name: "คำพูด 1",
			text: "พร้อมแล้ว",
			sourceCategory: "dialogue",
			sourceProvider: "translation-slot:dialogue-1",
			x: 20,
			y: 30,
			w: 240,
			h: 80,
			rotation: 0,
			fontSize: 28,
			alignment: "center",
			index: 0,
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();
		vi.spyOn(projectStore, "qcReport", "get").mockReturnValue({
			issues: [],
			errorCount: 0,
			warningCount: 0,
			infoCount: 0,
			pageCount: 2,
			checkedAt: now,
		});

		render(WorkspaceWorkBoardView);

		const reconcile = screen.getByRole("region", { name: "ปรับคิวงานตามสถานะหน้าจริง" });
		expect(within(reconcile).getByText("3 งานเปิด แต่ state หน้าเสร็จแล้ว")).toBeTruthy();
		expect(within(reconcile).getByText("แปล · 1")).toBeTruthy();
		expect(within(reconcile).getByText("คลีน · 1")).toBeTruthy();
		expect(within(reconcile).getByText("ไทป์เซ็ต · 1")).toBeTruthy();

		await fireEvent.click(within(reconcile).getByRole("button", { name: "ปิดงานที่เสร็จแล้ว" }));

		expect(projectStore.tasks.find((task) => task.id === "task-clean-drift")?.status).toBe("done");
		expect(projectStore.tasks.find((task) => task.id === "task-typeset-drift")?.status).toBe("done");
		expect(projectStore.tasks.find((task) => task.id === "task-translate-open")?.status).toBe("done");
		expect(projectStore.statusMsg).toBe("อัปเดตสถานะ 3 งานแล้ว");
		expect(screen.queryByRole("region", { name: "ปรับคิวงานตามสถานะหน้าจริง" })).toBeNull();
	});

	it("does not reconcile a typeset task while translated script and text layer are out of sync", async () => {
		const state = project();
		state.comments = [];
		state.tasks = [{
			id: "task-typeset-stale",
			type: "typeset",
			status: "review",
			priority: "normal",
			pageIndex: 0,
			title: "Typeset page 1",
			createdAt: now,
			updatedAt: now,
		}];
		state.pages[0].cleaningHandoff = {
			status: "clean_ready",
			updatedAt: now,
			updatedBy: "cleaner",
			typesetRecheckStatus: "verified",
			typesetRecheckUpdatedAt: now,
			typesetRecheckUpdatedBy: "qc",
		};
		state.pages[0].translationScriptSlots = [{
			id: "dialogue-1",
			label: "คำพูด 1",
			x: 18,
			y: 28,
			category: "dialogue",
			translatedText: "คำแปลล่าสุด",
			updatedAt: now,
		}];
		state.pages[0].translationHandoff = {
			status: "translated",
			updatedAt: now,
			updatedBy: "translator",
		};
		state.pages[0].textLayers = [{
			id: "typeset-dialogue-1",
			name: "คำพูด 1",
			text: "คำแปลเก่า",
			sourceCategory: "dialogue",
			sourceProvider: "translation-slot:dialogue-1",
			x: 20,
			y: 30,
			w: 240,
			h: 80,
			rotation: 0,
			fontSize: 28,
			alignment: "center",
			index: 0,
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();
		vi.spyOn(projectStore, "qcReport", "get").mockReturnValue({
			issues: [],
			errorCount: 0,
			warningCount: 0,
			infoCount: 0,
			pageCount: 2,
			checkedAt: now,
		});

		render(WorkspaceWorkBoardView);

		const currentPageHandoff = screen.getByRole("region", { name: "ส่งต่อหน้าปัจจุบันของทีม" });
		expect(within(currentPageHandoff).getByText("ไทป์เซ็ต · 1 กล่องต้อง sync")).toBeTruthy();
		expect(screen.queryByRole("region", { name: "ปรับคิวงานตามสถานะหน้าจริง" })).toBeNull();
		expect(projectStore.tasks.find((task) => task.id === "task-typeset-stale")?.status).toBe("review");
	});

	it("separates approved Team review task closure from final QC closure", async () => {
		const state = project();
		state.comments = [];
		state.tasks = [
			{
				id: "task-review-drift",
				type: "review",
				status: "review",
				priority: "normal",
				pageIndex: 0,
				title: "Review page 1",
				createdAt: now,
				updatedAt: now,
			},
		];
		state.reviewDecisions = [{
			id: "review-decision-approved",
			pageIndex: 0,
			status: "approved",
			body: "ผ่านแล้ว",
			actor: "QC",
			createdAt: now,
			updatedAt: now,
		}];
		state.pages[0].translationScriptSlots = [{
			id: "dialogue-1",
			label: "คำพูด 1",
			x: 18,
			y: 28,
			category: "dialogue",
			translatedText: "พร้อมส่ง QC",
			updatedAt: now,
		}];
		state.pages[0].translationHandoff = {
			status: "translated",
			updatedAt: now,
			updatedBy: "translator",
		};
		state.pages[0].cleaningHandoff = {
			status: "clean_ready",
			updatedAt: now,
			updatedBy: "cleaner",
			typesetRecheckStatus: "verified",
			typesetRecheckUpdatedAt: now,
			typesetRecheckUpdatedBy: "qc",
		};
		state.pages[0].textLayers = [{
			id: "typeset-dialogue-1",
			name: "คำพูด 1",
			text: "พร้อมส่ง QC",
			sourceCategory: "dialogue",
			sourceProvider: "translation-slot:dialogue-1",
			x: 20,
			y: 30,
			w: 240,
			h: 80,
			rotation: 0,
			fontSize: 28,
			alignment: "center",
			index: 0,
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();
		vi.spyOn(projectStore, "qcReport", "get").mockReturnValue({
			issues: [],
			errorCount: 0,
			warningCount: 0,
			infoCount: 0,
			pageCount: 2,
			checkedAt: now,
		});

		render(WorkspaceWorkBoardView);

		const reconcile = screen.getByRole("region", { name: "ปรับคิวงานตามสถานะหน้าจริง" });
		expect(within(reconcile).getByText("1 งานเปิด แต่ state หน้าเสร็จแล้ว")).toBeTruthy();
		expect(within(reconcile).getByText("QC · 1")).toBeTruthy();
		expect(within(reconcile).getByText("ปิด QC ต่อ · 1")).toBeTruthy();
		expect(within(reconcile).getByText("ปิดงานรีวิวที่ผ่านแล้วก่อน จากนั้นปิด QC หน้าในแผง QC / เครดิตเพื่อส่งกลับโปรเจกต์หลัก")).toBeTruthy();
		await fireEvent.click(within(reconcile).getByRole("button", { name: "ปิดงานที่เสร็จแล้ว" }));

		expect(projectStore.tasks.find((task) => task.id === "task-review-drift")?.status).toBe("done");
		await waitFor(() => expect(projectStore.statusMsg).toBe("ปิดงานรีวิวแล้ว ต่อด้วยปิด QC หน้า 1"));
		const roleMap = screen.getByRole("region", { name: "ทีมผลิตแยกบทบาท" });
		expect(within(roleMap).getByText("QC / เครดิต").closest("article")?.className).toContain("active");
		const qcBench = screen.getByRole("region", { name: "QC / เครดิต" });
		expect(within(qcBench).getByRole("button", { name: "ปิด QC หน้านี้" })).toBeTruthy();
		const currentPageHandoff = screen.getByRole("region", { name: "ส่งต่อหน้าปัจจุบันของทีม" });
		await waitFor(() => expect(within(currentPageHandoff).getByText("QC · รอปิด QC")).toBeTruthy());
	});

	it("marks consumed translator slots stale and updates the existing typeset layer explicitly", async () => {
		const state = project();
		state.pages[0].translationScriptSlots = [{
			id: "dialogue-1",
			label: "คำพูด 1",
			x: 18,
			y: 28,
			category: "dialogue",
			translatedText: "บรรทัดหนึ่งแก้ใหม่\nบรรทัดสองแก้ใหม่",
			updatedAt: now,
		}];
		state.pages[0].textLayers = [{
			id: "typeset-dialogue-1",
			name: "คำพูด 1",
			text: "บรรทัดหนึ่ง\nบรรทัดสอง",
			sourceCategory: "dialogue",
			sourceProvider: "translation-slot:dialogue-1",
			x: 20,
			y: 30,
			w: 240,
			h: 80,
			rotation: 0,
			fontSize: 28,
			alignment: "center",
			index: 0,
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();

		render(WorkspaceWorkBoardView);

		const roleMap = screen.getByRole("region", { name: "ทีมผลิตแยกบทบาท" });
		await fireEvent.click(within(roleMap).getByRole("button", { name: "เลือกบทบาท คนไทป์เซ็ต" }));
		const typesetterBench = screen.getByRole("region", { name: "ไทป์เซ็ตจากสคริปต์แปล" });
		expect(within(typesetterBench).getByText("เริ่มไทป์เซ็ตบนไฟล์ raw ได้")).toBeTruthy();
		expect(within(typesetterBench).getByText("ต้องตรวจอีกครั้งเมื่อคลีนพร้อม")).toBeTruthy();
		const staleDialogueCard = within(typesetterBench).getByText(/คำพูด 1 · ตำแหน่ง/).closest(".typesetter-script-card") as HTMLElement;
		expect(within(staleDialogueCard).getByText("สคริปต์เปลี่ยนจากกล่องข้อความ")).toBeTruthy();
		await fireEvent.click(within(staleDialogueCard).getByRole("button", { name: "อัปเดตกล่องข้อความ" }));
		const updatedLayers = projectStore.project?.pages[0]?.textLayers ?? [];
		expect(updatedLayers.filter((layer) => layer.sourceProvider === "translation-slot:dialogue-1")).toHaveLength(1);
		expect(updatedLayers).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: "typeset-dialogue-1",
				text: "บรรทัดหนึ่งแก้ใหม่\nบรรทัดสองแก้ใหม่",
				sourceProvider: "translation-slot:dialogue-1",
				x: 20,
				y: 30,
				w: 240,
				h: 80,
			}),
		]));
		expect(projectStore.statusMsg).toBe("อัปเดตกล่องข้อความจาก คำพูด 1 แล้ว");
	});

	it("surfaces text layers whose translator slot was deleted before QC", async () => {
		const state = project();
		state.comments = [];
		state.tasks = [];
		state.pages[0].translationHandoff = {
			status: "translated",
			updatedAt: now,
			updatedBy: "translator",
		};
		state.pages[0].translationScriptSlots = [];
		state.pages[0].cleaningHandoff = {
			status: "clean_ready",
			updatedAt: now,
			updatedBy: "cleaner",
			typesetRecheckStatus: "verified",
			typesetRecheckUpdatedAt: now,
			typesetRecheckUpdatedBy: "qc",
		};
		state.pages[0].textLayers = [{
			id: "typeset-custom-removed",
			name: "เสียงกรีด",
			text: "กรี๊ดดดด",
			sourceCategory: "sfx",
			sourceProvider: "translation-slot:custom-removed",
			x: 20,
			y: 30,
			w: 240,
			h: 80,
			rotation: 0,
			fontSize: 28,
			alignment: "center",
			index: 0,
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();

		render(WorkspaceWorkBoardView);

		const currentPageHandoff = screen.getByRole("region", { name: "ส่งต่อหน้าปัจจุบันของทีม" });
		expect(within(currentPageHandoff).getByText("ไทป์เซ็ต · 1 กล่องสคริปต์หาย")).toBeTruthy();
		const mainHandoff = screen.getByRole("region", { name: "ส่งกลับโปรเจกต์หลักของทีม" });
		expect(within(mainHandoff).getByText("ไทป์เซ็ต · 1 หน้าสคริปต์หาย")).toBeTruthy();

		const roleMap = screen.getByRole("region", { name: "ทีมผลิตแยกบทบาท" });
		await fireEvent.click(within(roleMap).getByRole("button", { name: "เลือกบทบาท คนไทป์เซ็ต" }));
		const typesetterBench = screen.getByRole("region", { name: "ไทป์เซ็ตจากสคริปต์แปล" });
		const orphanGroup = within(typesetterBench).getByRole("region", { name: "กล่องข้อความที่สคริปต์ต้นทางหาย" });
		expect(within(orphanGroup).getByText("สคริปต์ต้นทางถูกลบจากคนแปล")).toBeTruthy();

		await fireEvent.click(within(orphanGroup).getByRole("button", { name: "เก็บเป็นกล่องอิสระ" }));

		expect(projectStore.project?.pages[0]?.textLayers[0].sourceProvider).toBeUndefined();
		expect(projectStore.statusMsg).toBe("เก็บกล่องข้อความนี้เป็นงานอิสระแล้ว");
		expect(screen.queryByRole("region", { name: "กล่องข้อความที่สคริปต์ต้นทางหาย" })).toBeNull();
	});

	it("shows a Team QC and credit control bench without owning review decisions itself", async () => {
		const state = project();
		state.pages[0].translationScriptSlots = [{
			id: "dialogue-1",
			label: "คำพูด 1",
			x: 18,
			y: 28,
			category: "dialogue",
			translatedText: "สคริปต์ล่าสุด",
			updatedAt: now,
		}];
		state.pages[0].textLayers = [
			{
				id: "typeset-dialogue-1",
				name: "คำพูด 1",
				text: "ข้อความเก่า",
				sourceCategory: "dialogue",
				sourceProvider: "translation-slot:dialogue-1",
				x: 20,
				y: 30,
				w: 240,
				h: 80,
				rotation: 0,
				fontSize: 28,
				alignment: "center",
				index: 0,
			},
			{
				id: "credit-text-1",
				text: "เครดิตท้ายหน้า",
				sourceCategory: "credit",
				x: 0,
				y: 980,
				w: 420,
				h: 44,
				rotation: 0,
				fontSize: 18,
				alignment: "center",
				index: 1,
			},
		];
		state.pages[0].imageLayers = [{
			id: "credit-image-1",
			imageId: "credit-logo",
			imageName: "credit-logo.png",
			x: 20,
			y: 920,
			w: 180,
			h: 50,
			rotation: 0,
			opacity: 1,
			index: 0,
			role: "credit",
		}];
		state.pages[1].textLayers = [{
			id: "credit-text-2",
			text: "เครดิตทั้งตอน",
			sourceCategory: "credit",
			x: 0,
			y: 980,
			w: 420,
			h: 44,
			rotation: 0,
			fontSize: 18,
			alignment: "center",
			index: 0,
		}];
		state.reviewDecisions = [{
			id: "review-decision-1",
			pageIndex: 0,
			status: "changes_requested",
			body: "แก้ขอบคำ",
			actor: "QC",
			createdAt: now,
			updatedAt: now,
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();

		render(WorkspaceWorkBoardView);

		const roleMap = screen.getByRole("region", { name: "ทีมผลิตแยกบทบาท" });
		await fireEvent.click(within(roleMap).getByRole("button", { name: "เลือกบทบาท QC / เครดิต" }));
		const qcBench = screen.getByRole("region", { name: "QC / เครดิต" });
		expect(within(qcBench).getByText("งานที่ต้องตัดสินก่อนส่งต่อ")).toBeTruthy();
		expect(within(qcBench).getByText("คลีน หน้า 2")).toBeTruthy();
		expect(within(qcBench).getByText("หน้านี้ 2 / ทั้งตอน 3 · ร่าง/ภายใน ไม่บังคับ")).toBeTruthy();
		expect(within(qcBench).getByText("เป้าส่งออก ร่าง/ภายใน: ไม่มีเครดิตก็ไม่บล็อกส่งกลับ แต่ QC ยังเปิดเครื่องมือเครดิตได้")).toBeTruthy();
		expect(within(qcBench).getByRole("button", { name: "ร่าง/ภายใน ไม่บังคับ" }).getAttribute("aria-pressed")).toBe("true");
		expect(within(qcBench).getByRole("button", { name: "เผยแพร่/ส่งออก ต้องมี" }).getAttribute("aria-pressed")).toBe("false");
		expect(within(qcBench).getByText("1/1 ช่องแปล")).toBeTruthy();
		expect(within(qcBench).getByText("1 กล่องต้อง sync")).toBeTruthy();
		expect(within(qcBench).getByText("1 เปิดบนหน้านี้")).toBeTruthy();
		expect(within(qcBench).getByText("ส่งกลับแก้ล่าสุด")).toBeTruthy();
		expect(within(qcBench).queryByText("ผ่านรีวิวหน้า")).toBeNull();
		expect(within(qcBench).queryByText("ส่งกลับแก้")).toBeNull();
		expect(screen.queryByRole("region", { name: "ส่งงานคลีน" })).toBeNull();
		expect(screen.queryByRole("region", { name: "โต๊ะแปลข้างรูป" })).toBeNull();
		expect(screen.queryByRole("region", { name: "ไทป์เซ็ตจากสคริปต์แปล" })).toBeNull();
		expect(screen.queryByRole("region", { name: "ศูนย์คำสั่งตรวจ" })).toBeNull();
	});

	it("routes Team QC actions to the editor work panel and credit tools instead of duplicating those surfaces", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();
		vi.spyOn(projectStore, "goToPage").mockResolvedValue(true);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspaceWorkBoardView);

		const roleMap = screen.getByRole("region", { name: "ทีมผลิตแยกบทบาท" });
		await fireEvent.click(within(roleMap).getByRole("button", { name: "เลือกบทบาท QC / เครดิต" }));
		const qcBench = screen.getByRole("region", { name: "QC / เครดิต" });
		await fireEvent.click(within(qcBench).getByRole("button", { name: "รีวิวงานนี้" }));

		expect(projectStore.goToPage).toHaveBeenCalledWith(1, null);
		// Focus mode was removed: the QC action now opens the editor with the
		// selected blocker in the contextual Work panel.
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		expect(editorUiStore.rightPanelMode).toBe("work");

		editorUiStore.openWorkBoard();
		await waitFor(() => expect(screen.getByRole("region", { name: "บอร์ดงานตอน" })).toBeTruthy());
		await fireEvent.click(within(roleMap).getByRole("button", { name: "เลือกบทบาท QC / เครดิต" }));
		const tokenBefore = editorUiStore.creditToolsFocusToken;
		await fireEvent.click(within(screen.getByRole("region", { name: "QC / เครดิต" })).getByRole("button", { name: "เปิดเครื่องมือเครดิต" }));

		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.creditToolsFocusToken).toBe(tokenBefore + 1);
		expect(projectStore.statusMsg).toBe("เปิดเครื่องมือเครดิตในแผงเลเยอร์แล้ว");
	});

	it("copies the solo blocker work-board link from the work board", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		projectStore.__setProjectForTesting(project());
		editorUiStore.openWorkBoard();

		render(WorkspaceWorkBoardView);

		const soloBlocker = screen.getByRole("region", { name: "คำสั่งตัวบล็อกสำหรับ solo" });
		await fireEvent.click(within(soloBlocker).getByText("เพิ่มเติม"));
		await fireEvent.click(within(soloBlocker).getByRole("button", { name: "คัดลอกลิงก์" }));

		// Focus mode was removed: the shared link now points at the team Work Board.
		expect(writeText).toHaveBeenCalledWith("http://localhost:3000/projects/project-1/work");
		expect(projectStore.statusMsg).toBe("คัดลอกลิงก์งานแล้ว");
	});

	it("promotes accepted AI results without layers as the solo blocker", async () => {
		const state = project();
		state.tasks = [];
		state.comments = [];
		state.aiReviewMarkers = [aiReviewMarker()];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openWorkBoard();
		editorStore.editor = { focusImageRegion: vi.fn() } as any;

		render(WorkspaceWorkBoardView);

		const soloBlocker = screen.getByRole("region", { name: "คำสั่งตัวบล็อกสำหรับ solo" });
		expect(within(soloBlocker).getByText("วางเลเยอร์ AI หน้า 1")).toBeTruthy();
		expect(within(soloBlocker).getByText(/Export ติดอยู่ที่งานนี้/)).toBeTruthy();
		expect(within(soloBlocker).getByRole("button", { name: "พรีวิวตัวบล็อก หน้า 1" })).toBeTruthy();
		expect(within(soloBlocker).getByText(/พื้นที่ AI ผ่านแล้ว/)).toBeTruthy();
		expect(within(soloBlocker).getByText(/รอวางเป็นเลเยอร์แก้ได้/)).toBeTruthy();
		expect(soloBlocker.querySelector(".blocker-region-target")).toBeTruthy();
		await fireEvent.click(within(soloBlocker).getByRole("button", { name: "วางเลเยอร์ AI" }));
		expect(projectStore.selectedAiReviewMarkerId).toBe("marker-1");
		expect(editorStore.editor.focusImageRegion).toHaveBeenCalledWith({ x: 20, y: 30, w: 120, h: 80 });
		expect(editorUiStore.rightPanelMode).toBe("layers");
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		expect(projectStore.statusMsg).toBe("เปิดจุดวางเลเยอร์ AI แล้ว");
		expect(within(soloBlocker).queryByText("คิวนี้เคลียร์แล้ว")).toBeNull();
	});

	// Focus mode was removed: the selected role's next work now opens in the editor
	// with the task selected in the contextual Work panel.
	it("routes the selected role's next work directly into the editor work panel", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();
		vi.spyOn(projectStore, "goToPage").mockResolvedValue(true);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspaceWorkBoardView);

		const roleNext = screen.getByRole("region", { name: "งานถัดไปของโหมดที่เลือก" });
		expect(within(roleNext).getByText("ต้องแก้เพื่อปลด Export")).toBeTruthy();
		expect(within(roleNext).getByText("คลีน หน้า 2")).toBeTruthy();
		expect(within(roleNext).queryByText("Page 2 - Clean page 2")).toBeNull();
		expect(within(roleNext).getByText("หน้า 2 / ยังไม่เริ่ม / @Mai / ด่วน")).toBeTruthy();

		await fireEvent.click(within(roleNext).getByRole("button", { name: "แก้งานนี้" }));

		expect(projectStore.goToPage).toHaveBeenCalledWith(1, null);
		expect(editorStore.refreshTextLayers).toHaveBeenCalled();
		expect(projectStore.selectedWorkflowTaskId).toBe("task-1");
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		expect(editorUiStore.rightPanelMode).toBe("work");
		await waitFor(() => expect(window.location.pathname).toMatch(/\/projects\/project-1\/(editor|pages\/\d+\/editor)/));
	});

	// Note: a former test ("keeps the solo export blocker visible when the
	// selected role queue is clear") was removed with the workflow-preset chooser.
	// It relied on the `ai-heavy` preset to artificially empty the role queue and
	// on the preset-selector status copy ("รีวิวผล AI" / "มีตัวบล็อกอื่นต้องเคลียร์").
	// With presets gone, that scenario is identical to the hero-blocker test below.

	it("keeps the solo export blocker as the hero even when the selected role also has work", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openWorkBoard();

		render(WorkspaceWorkBoardView);

		const soloBlocker = screen.getByRole("region", { name: "คำสั่งตัวบล็อกสำหรับ solo" });
		expect(within(soloBlocker).getByText("คลีน หน้า 2")).toBeTruthy();
		expect(screen.queryByRole("region", { name: "งานถัดไปของโหมดที่เลือก" })).toBeNull();
	});

	it("does not show a dead solo role action when the selected role and export are both clear", async () => {
		const state = project();
		state.tasks = state.tasks.map((task) => ({ ...task, status: "done" as const }));
		state.comments = [];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openWorkBoard();

		render(WorkspaceWorkBoardView);

		const roleNext = screen.getByRole("region", { name: "งานถัดไปของโหมดที่เลือก" });
		expect(within(roleNext).getByText("คิวนี้เคลียร์แล้ว")).toBeTruthy();
		expect(within(roleNext).queryByRole("button", { name: "ทำงานนี้" })).toBeNull();
		expect(within(roleNext).getByRole("button", { name: "ดูหน้า" })).toBeTruthy();
		expect(within(roleNext).queryByRole("button", { name: "เปิดหน้าแก้" })).toBeNull();
	});

	it("does not show a misleading clear next strip while a Team production bench owns page-state work", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();

		render(WorkspaceWorkBoardView);

		const roleMap = screen.getByRole("region", { name: "ทีมผลิตแยกบทบาท" });
		await fireEvent.click(within(roleMap).getByRole("button", { name: "เลือกบทบาท คนคลีน" }));

		expect(screen.getByRole("region", { name: "ส่งงานคลีน" })).toBeTruthy();
		expect(screen.queryByRole("region", { name: "งานถัดไปของโหมดที่เลือก" })).toBeNull();
		expect(screen.queryByText("คนคลีน/ไทป์เซ็ต ไม่มีงานค้างในตอนนี้")).toBeNull();
	});

	it("replaces clear Team work board no-op controls with receipts instead of disabled buttons", async () => {
		const state = project();
		state.tasks = [];
		state.comments = [];
		projectStore.__setProjectForTesting(state);
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();

		const { container } = render(WorkspaceWorkBoardView);

		expect(screen.getAllByText("เคลียร์แล้ว").length).toBeGreaterThan(0);
		expect(screen.getByText("ไม่มีคิวเปิด")).toBeTruthy();
		expect(screen.getByText("ไม่มีตัวบล็อก")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "กำหนดคนรับงาน" })).toBeNull();
		expect(screen.getByText("ทุกงานเปิดมีคนรับงานแล้ว")).toBeTruthy();
		expect(container.querySelectorAll("button:disabled")).toHaveLength(0);
	});

	it("opens the exact assigned task row instead of the first task in the owner queue", async () => {
		const state = project();
		state.tasks = [
			state.tasks[0],
			{
				id: "task-3",
				type: "typeset",
				status: "todo",
				priority: "normal",
				pageIndex: 0,
				title: "Typeset page 1",
				assignee: "Mai",
				createdAt: now,
				updatedAt: now,
			},
			state.tasks[1],
		];
		projectStore.__setProjectForTesting(state);
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();
		vi.spyOn(projectStore, "goToPage").mockResolvedValue(true);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspaceWorkBoardView);

		await openQueueOverview();
		const assignedWork = screen.getByRole("region", { name: "คิวคนรับงาน" });
		await fireEvent.click(within(assignedWork).getByRole("button", { name: /ไทป์เซ็ตหน้า 1/ }));

		expect(projectStore.goToPage).not.toHaveBeenCalledWith(1, null);
		expect(projectStore.selectedWorkflowTaskId).toBe("task-3");
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/pages/1/editor"));
	});

	it("opens review command lanes into the editor work panel and canvas surfaces", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openWorkBoard();
		vi.spyOn(projectStore, "goToPage").mockResolvedValue(true);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspaceWorkBoardView);

		await fireEvent.click(screen.getByText("รายละเอียดงานเพิ่มเติม"));
		const commentsCommand = screen.getByRole("group", { name: "คำสั่งตรวจโน้ต" });
		await fireEvent.click(within(commentsCommand).getByRole("button", { name: "ทำงานนี้" }));

		// Focus mode was removed: review commands now open the selected item in the
		// editor's contextual Work panel.
		expect(projectStore.selectedProjectCommentId).toBe("comment-1");
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		expect(editorUiStore.rightPanelMode).toBe("work");

		editorUiStore.openWorkBoard();
		await waitFor(() => expect(screen.getByRole("region", { name: "บอร์ดงานตอน" })).toBeTruthy());

		await fireEvent.click(screen.getByText("รายละเอียดงานเพิ่มเติม"));
		const blockersCommand = screen.getByRole("group", { name: "คำสั่งปลดตัวบล็อก" });
		await fireEvent.click(within(blockersCommand).getByText("เพิ่มเติม"));
		await fireEvent.click(within(blockersCommand).getByRole("button", { name: "ดูหน้า 2" }));

		expect(projectStore.goToPage).toHaveBeenCalledWith(1, null);
		expect(projectStore.selectedWorkflowTaskId).toBe("task-1");
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/pages/2/editor"));
	});

	it("does not route or select target work when save-blocked page switching fails", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openWorkBoard();
		vi.spyOn(projectStore, "goToPage").mockResolvedValue(false);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspaceWorkBoardView);

		await fireEvent.click(screen.getByText("รายละเอียดงานเพิ่มเติม"));
		const blockersCommand = screen.getByRole("group", { name: "คำสั่งปลดตัวบล็อก" });
		await fireEvent.click(within(blockersCommand).getByText("เพิ่มเติม"));
		await fireEvent.click(within(blockersCommand).getByRole("button", { name: "ดูหน้า 2" }));

		expect(projectStore.goToPage).toHaveBeenCalledWith(1, null);
		expect(editorStore.refreshTextLayers).not.toHaveBeenCalled();
		expect(projectStore.selectedWorkflowTaskId).toBeNull();
		expect(editorUiStore.workspaceView).toBe("work");
		expect(window.location.pathname).toBe("/projects/project-1/work");
	});

	it("opens missing-page work board items on the current canvas repair path", async () => {
		const base = project();
		projectStore.__setProjectForTesting({
			...base,
			pages: [base.pages[0]],
			tasks: [{
				...base.tasks[0],
				id: "task-missing-page",
				pageIndex: 4,
				title: "Clean deleted page",
			}],
			comments: [],
		});
		editorUiStore.openWorkBoard();
		const goToPage = vi.spyOn(projectStore, "goToPage").mockResolvedValue(true);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspaceWorkBoardView);

		await openQueueOverview();
		await fireEvent.click(screen.getByRole("button", { name: /งาน \/ หน้า 5 \/ เลยกำหนด .*Clean deleted page/ }));

		expect(goToPage).not.toHaveBeenCalled();
		expect(projectStore.selectedWorkflowTaskId).toBe("task-missing-page");
		expect(projectStore.statusMsg).toBe("หน้างานหาย; ย้ายไปหน้าที่ถูกต้องหรือปิดงานนี้");
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/pages/1/editor"));
	});

	it("opens missing-page comment handoffs on the current canvas repair path", async () => {
		const base = project();
		projectStore.__setProjectForTesting({
			...base,
			pages: [base.pages[0]],
			tasks: [],
			comments: [{
				...base.comments[0],
				id: "comment-missing-page",
				pageIndex: 4,
				body: "This comment belongs to a deleted page",
			}],
		});
		editorUiStore.openWorkBoard();
		const goToPage = vi.spyOn(projectStore, "goToPage").mockResolvedValue(true);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspaceWorkBoardView);

		await fireEvent.click(screen.getByText("รายละเอียดงานเพิ่มเติม"));
		const commentsCommand = screen.getByRole("group", { name: "คำสั่งตรวจโน้ต" });
		await fireEvent.click(within(commentsCommand).getByText("เพิ่มเติม"));
		await fireEvent.click(within(commentsCommand).getByRole("button", { name: "ดูหน้า 5" }));

		expect(goToPage).not.toHaveBeenCalled();
		expect(projectStore.selectedProjectCommentId).toBe("comment-missing-page");
		expect(projectStore.statusMsg).toBe("หน้าโน้ตหาย; ปิดหรือสร้างใหม่บนหน้าที่ถูกต้อง");
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/pages/1/editor"));
	});

	it("opens an assigned queue into the canvas URL surface", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();
		vi.spyOn(projectStore, "goToPage").mockResolvedValue(true);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspaceWorkBoardView);

		await openQueueOverview();
		const assignedWork = screen.getByRole("region", { name: "คิวคนรับงาน" });
		expect(within(assignedWork).getByRole("button", { name: "เปิดหน้า 2" })).toBeTruthy();
		expect(within(assignedWork).queryByRole("button", { name: "เปิดหน้าแก้" })).toBeNull();
		await fireEvent.click(within(assignedWork).getByRole("button", { name: /คลีนหน้า 2/ }));

		expect(projectStore.goToPage).toHaveBeenCalledWith(1, null);
		expect(editorStore.refreshTextLayers).toHaveBeenCalled();
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/pages/2/editor"));
	});

	it("opens the import review route from the work board", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openWorkBoard();

		render(WorkspaceWorkBoardView);

		await fireEvent.click(screen.getByRole("button", { name: "Import ข้อความ" }));

		await waitFor(() => expect(editorUiStore.workspaceView).toBe("import"));
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/import"));
	});

	// Focus mode was removed: the lane-panel "open work" affordance now opens the
	// current page in the editor with the contextual Work panel.
	it("opens the current page in the editor work panel from the work board lane panel", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openWorkBoard();

		render(WorkspaceWorkBoardView);

		await openQueueOverview();
		await fireEvent.click(screen.getByRole("button", { name: "เปิดงานหน้านี้" }));

		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		expect(editorUiStore.rightPanelMode).toBe("work");
		await waitFor(() => expect(window.location.pathname).toMatch(/\/projects\/project-1\/(editor|pages\/\d+\/editor)/));
	});

	// Regression (P1): "ทำคิวนี้" / "ทำคิวแรก" must open the GROUP's first open task on
	// its OWN page — not leave the user on the current page. (Focus mode was removed;
	// the old focusAssignedGroup passed a task id into openFocus() which ignored it.)
	it("opens the assigned group's first open task on its own page from 'ทำคิวนี้'", async () => {
		const state = project();
		// Single open task assigned to Mai, sitting on page 2 (index 1). Current page is 0,
		// so a correct fix must navigate to page index 1 and select that task.
		state.tasks = [
			{
				id: "assigned-task-1",
				type: "clean",
				status: "todo",
				priority: "urgent",
				pageIndex: 1,
				title: "Clean page 2",
				assignee: "Mai",
				createdAt: now,
				updatedAt: now,
			},
		];
		state.comments = [];
		state.currentPage = 0;
		projectStore.__setProjectForTesting(state);
		editorUiStore.setWorkspaceMode("team");
		editorUiStore.openWorkBoard();

		render(WorkspaceWorkBoardView);

		const assignedWork = screen.getByRole("region", { name: "คิวคนรับงาน" });
		const doThisQueue = within(assignedWork).getByRole("button", { name: "ทำคิวนี้" });
		await fireEvent.click(doThisQueue);

		// Navigated to the group's first open page (index 1) — NOT stuck on page 0.
		await waitFor(() => expect(projectStore.project?.currentPage).toBe(1));
		// And the group's first open task is selected in the contextual Work panel.
		expect(projectStore.selectedWorkflowTaskId).toBe("assigned-task-1");
		expect(editorUiStore.rightPanelMode).toBe("work");
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
	});
});
