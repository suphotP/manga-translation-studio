import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import "$lib/i18n";
import WorkspacePagesView from "$lib/components/WorkspacePagesView.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import { workspacesStore } from "$lib/stores/workspaces.svelte.ts";

function __ownerWs() { return { workspaceId: "ws-test", name: "T", planId: "free", storageIncludedBytes: 0, storageExtraBytes: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", memberRole: "owner" as const, memberScope: {} }; }
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
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	editorStore.textLayers = [];
	editorStore.imageLayers = [];
	editorStore.editor = null;
	editorStore.hasImage = false;
	// Lead surface is admin-only now — seed an owner workspace so lead-surface tests render it.
	workspacesStore.workspaces = [__ownerWs()];
	workspacesStore.currentWorkspaceId = "ws-test";
});

afterEach(() => {
	workspacesStore.workspaces = [];
	workspacesStore.currentWorkspaceId = null;
});

describe("WorkspacePagesView", () => {
	it("assigns current-page workflow tasks directly from the Pages lead surface", async () => {
		const state = project();
		state.tasks = [
			{
				id: "task-current",
				type: "translate",
				status: "todo",
				priority: "normal",
				pageIndex: 0,
				title: "Translate page 1",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "task-done",
				type: "typeset",
				status: "done",
				priority: "normal",
				pageIndex: 0,
				title: "Typeset page 1",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "task-next",
				type: "review",
				status: "review",
				priority: "high",
				pageIndex: 1,
				title: "Review page 2",
				createdAt: now,
				updatedAt: now,
			},
		];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openPages();
		const bulkUpdateTasks = vi.spyOn(projectStore, "bulkUpdateTasks").mockResolvedValue(1);

		render(WorkspacePagesView);

		const panel = screen.getByRole("region", { name: "มอบหมายงานจากหน้า" });
		expect(within(panel).getByText(/1 งานเปิด/)).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "มอบหมาย" }));
		expect(document.activeElement).toBe(within(panel).getByLabelText("ขอบเขต"));

		await fireEvent.input(within(panel).getByLabelText("คนรับงาน"), { target: { value: "@lead" } });
		await fireEvent.change(within(panel).getByLabelText("ความด่วน"), { target: { value: "high" } });
		await fireEvent.click(within(panel).getByRole("button", { name: "มอบหมาย 1 งาน" }));

		expect(bulkUpdateTasks).toHaveBeenCalledWith(
			{ taskIds: ["task-current"], assignee: "lead", priority: "high" },
			expect.any(Function),
			"ไม่มีงานที่เปลี่ยน",
		);
	});

	it("renders a wide project page queue with chapter summary", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openPages();
		editorStore.textLayers = [{ id: "layer-1", text: "Done" } as any];

		const rendered = render(WorkspacePagesView);

		expect(screen.getByRole("region", { name: "หน้าในงาน" })).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Alpha Chapter 1" })).toBeTruthy();
		expect(screen.getByText((_content, element) =>
			element?.tagName.toLowerCase() === "p"
			&& /2\s*หน้า\s*\/\s*EN\s*\/\s*พร้อม/i.test(element.textContent?.replace(/\s+/g, " ") ?? ""),
		)).toBeTruthy();
		expect(screen.getAllByText((_content, element) =>
			/2\s*หน้า/i.test(element?.textContent?.replace(/\s+/g, " ") ?? ""),
		).length).toBeGreaterThan(0);
		// "ต้องเช็ก" now renders as a StatTile (label above value), so the count
		// and label live in sibling <p> nodes — match the tile that holds both.
		expect(screen.getAllByText("ต้องเช็ก").some((node) =>
			(node.closest("div")?.textContent?.replace(/\s+/g, "") ?? "").includes("ต้องเช็ก1"),
		)).toBe(true);
		expect(screen.getByRole("region", { name: "งานถัดไปในหน้า" })).toBeTruthy();
		// page-2 is art-only with a default open review task. The task no longer
		// blocks export, so the next-action card now reports the page as export-ready
		// ("หน้าพร้อม Export") while still exposing the open task in the page queue.
		expect(screen.getAllByText("หน้าพร้อม Export").length).toBeGreaterThan(0);
		expect(screen.getAllByText("1 งานเปิด / Review page 2").length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText("หน้า 2").length).toBeGreaterThanOrEqual(1);
		expect(screen.queryByText("P2 - page-2")).toBeNull();
		// The page grid now uses PageTile (an anchor for cmd-click navigation), so the
		// page-1 open affordance is a link, not a button.
		expect(screen.getByRole("link", { name: "เปิดหน้า 1" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "เปิดหน้าแก้" })).toBeNull();
		expect(screen.getByRole("button", { name: "เปิดงานหน้า 2" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "ตรวจหน้า 2" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ตรวจหน้านี้" })).toBeNull();
		expect(screen.getByRole("button", { name: "เปิดหน้า 2: รอรีวิวผล" })).toBeTruthy();
		const exportGate = screen.getByRole("region", { name: "Export ตอนนี้" });
		// This chapter is art-only on page 2 (no text layers) with a default open
		// review task. Neither is a real export blocker (aligned with the backend
		// readiness contract), so the gate is now READY and the ZIP export button is
		// ENABLED — there is no blocker checklist. The open task still shows in the
		// page queue as a workflow signal ("1 งานเปิด"), it just no longer holds export.
		expect(within(exportGate).queryByText("ส่งออกยังไม่พร้อม")).toBeNull();
		expect(within(exportGate).queryByRole("list", { name: "เช็กลิสต์ก่อน Export" })).toBeNull();
		const exportZipButton = within(exportGate).getByRole("button", { name: "Export ZIP" }) as HTMLButtonElement;
		expect(exportZipButton.disabled).toBe(false);
		// The page-2 open task is still reachable from the page queue and opens that
		// task in the editor's contextual Work panel.
		await fireEvent.click(screen.getByRole("button", { name: "เปิดงานหน้า 2" }));
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		expect(editorUiStore.rightPanelMode).toBe("work");
		await waitFor(() => expect(window.location.pathname).toMatch(/\/projects\/project-1\/pages\/\d+\/editor/));
	});

	it("uses project source language and current member studio role in assigned mode", () => {
		const state = project();
		state.sourceLang = "ko";
		projectStore.__setProjectForTesting(state);
		projectStore.currentWorkspaceMember = {
			workspaceId: "workspace-1",
			userId: "translator-1",
			role: "editor",
			memberStudioRole: "translator",
			scope: {},
			createdAt: now,
			updatedAt: now,
		};
		editorUiStore.openPages();
		editorUiStore.setWorkspaceTeamMode("assigned");

		render(WorkspacePagesView);

		expect(screen.getAllByText(/KO→/).length).toBeGreaterThan(0);
		expect(screen.getByText(/ทำต่อ · แปล/)).toBeTruthy();
		expect(screen.getAllByText(/คิวแปล/).length).toBeGreaterThan(0);
	});

	it("gives ready pages a direct chapter export gate from the Pages surface", async () => {
		const state = project();
		state.tasks = [];
		state.pages[1].textLayers = [{ id: "layer-2", text: "Done too" } as any];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openPages();
		editorStore.textLayers = [{ id: "layer-1", text: "Done" } as any];
		const exportPageBatch = vi.spyOn(projectStore, "exportPageBatch").mockResolvedValue(undefined);

		render(WorkspacePagesView);

		const exportGate = screen.getByRole("region", { name: "Export ตอนนี้" });
		expect(within(exportGate).getByText("ส่งออก ZIP พร้อม")).toBeTruthy();
		expect(within(exportGate).getByText("2/2 หน้าพร้อม สร้าง ZIP ได้จากหน้านี้")).toBeTruthy();
		expect(within(exportGate).getByRole("button", { name: "เช็ก Export" })).toBeTruthy();
		expect(within(exportGate).getByRole("button", { name: "Export ZIP" })).toBeTruthy();
		expect(within(exportGate).queryByText("เคลียร์ก่อน Export")).toBeNull();

		await fireEvent.click(within(exportGate).getByRole("button", { name: "เช็ก Export" }));
		expect(within(exportGate).getByText("ส่งออกพร้อมแล้ว: 2 หน้า")).toBeTruthy();

		await fireEvent.click(within(exportGate).getByRole("button", { name: "Export ZIP" }));
		// Default = no split: the third arg carries no split options.
		expect(exportPageBatch).toHaveBeenCalledWith([0, 1], undefined, {});
	});

	it("threads the webtoon split selection into the chapter export", async () => {
		const state = project();
		state.tasks = [];
		state.pages[1].textLayers = [{ id: "layer-2", text: "Done too" } as any];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openPages();
		editorStore.textLayers = [{ id: "layer-1", text: "Done" } as any];
		const exportPageBatch = vi.spyOn(projectStore, "exportPageBatch").mockResolvedValue(undefined);

		render(WorkspacePagesView);
		const exportGate = screen.getByRole("region", { name: "Export ตอนนี้" });
		// Pick "by piece count" and confirm the count input appears.
		const modeSelect = within(exportGate).getByLabelText("แบ่งรูป") as HTMLSelectElement;
		await fireEvent.change(modeSelect, { target: { value: "count" } });
		const countInput = within(exportGate).getByLabelText("จำนวนชิ้นต่อหน้า") as HTMLInputElement;
		await fireEvent.input(countInput, { target: { value: "12" } });

		await fireEvent.click(within(exportGate).getByRole("button", { name: "Export ZIP" }));
		expect(exportPageBatch).toHaveBeenCalledWith([0, 1], undefined, { split: { mode: "count", pieceCount: 12 } });
	});

	it("promotes accepted AI placement with a creator preview before export metrics", async () => {
		const state = project();
		state.tasks = [];
		state.aiReviewMarkers = [aiReviewMarker()];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openPages();
		editorStore.textLayers = [{ id: "layer-1", text: "Done" } as any];
		editorStore.editor = { focusImageRegion: vi.fn() } as any;

		render(WorkspacePagesView);

		const nextAction = screen.getByRole("region", { name: "งานถัดไปในหน้า" });
		expect(within(nextAction).getByText("วางผล AI ก่อน Export")).toBeTruthy();
		expect(within(nextAction).getByRole("button", { name: "พรีวิวงาน หน้า 1" })).toBeTruthy();
		expect(within(nextAction).getAllByText(/ผล AI ผ่านแล้วแต่ยังไม่วาง/).length).toBeGreaterThanOrEqual(1);
		expect(within(nextAction).getByText(/กรอบทองคือพื้นที่ที่ต้องวางเป็นเลเยอร์/)).toBeTruthy();
		expect(nextAction.querySelector(".next-visual-frame i")).toBeTruthy();
		await fireEvent.click(within(nextAction).getByRole("button", { name: "วางเลเยอร์ AI หน้า 1" }));
		expect(projectStore.selectedAiReviewMarkerId).toBe("marker-1");
		expect(editorStore.editor.focusImageRegion).toHaveBeenCalledWith({ x: 20, y: 30, w: 120, h: 80 });
		expect(editorUiStore.rightPanelMode).toBe("layers");
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		expect(window.location.pathname).toBe("/projects/project-1/pages/1/editor");
		expect(projectStore.statusMsg).toBe("เปิดจุดวางเลเยอร์ AI แล้ว");
	});

	it("blocks public export without chapter credit and routes to the credit workflow", async () => {
		const state = project();
		state.tasks = [];
		state.creditPolicy = "required";
		projectStore.__setProjectForTesting(state);
		editorUiStore.openPages();
		editorStore.textLayers = [{ id: "layer-1", text: "Done" } as any];

		render(WorkspacePagesView);

		expect(screen.getByText("Public/Export ติดเครดิต")).toBeTruthy();
		const creditGate = screen.getByRole("region", { name: "เครดิตก่อน Public/Export" });
		expect(within(creditGate).getByText("Public/Export ต้องมีเครดิต")).toBeTruthy();
		expect(within(creditGate).getByText("เพิ่มเครดิตก่อน Export ชุดขาย")).toBeTruthy();
		expect(within(creditGate).getByText(/ร่าง\/ภายใน ยังตรวจหน้าได้ต่อ/)).toBeTruthy();

		await fireEvent.click(within(creditGate).getByRole("button", { name: "เปิดเครดิต" }));

		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.creditToolsFocusToken).toBe(1);
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		expect(window.location.pathname).toBe("/projects/project-1/pages/1/editor");
		expect(projectStore.statusMsg).toBe("เปิดเครื่องมือเครดิตในแผงเลเยอร์แล้ว");
	});

	it("falls back to persisted current-page layers before the editor image loads", () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openPages();
		editorStore.textLayers = [];
		editorStore.hasImage = false;

		render(WorkspacePagesView);

		expect(screen.getByText((_content, element) =>
			element?.tagName.toLowerCase() === "p"
			&& /2\s*หน้า\s*\/\s*EN\s*\/\s*พร้อม/i.test(element.textContent?.replace(/\s+/g, " ") ?? ""),
		)).toBeTruthy();
		expect(screen.getByRole("button", { name: /เปิดหน้า 1: พร้อม/i })).toBeTruthy();
	});

	it("opens a page into the canvas URL surface", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openPages();
		editorStore.textLayers = [{ id: "layer-1", text: "Done" } as any];
		vi.spyOn(projectStore, "goToPage").mockResolvedValue(true);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspacePagesView);

		const chapterQueue = screen.getByRole("region", { name: "หน้าในตอน" });
		await fireEvent.click(within(chapterQueue).getByRole("button", { name: "เปิดหน้า 2: รอรีวิวผล" }));

		expect(projectStore.goToPage).toHaveBeenCalledWith(1, null);
		expect(editorStore.refreshTextLayers).toHaveBeenCalled();
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/pages/2/editor"));
	});

	it("copies the next page canvas link from the pages queue", async () => {
		window.history.replaceState({}, "", "/projects/project-1/pages");
		projectStore.__setProjectForTesting(project());
		editorUiStore.openPages();
		editorStore.textLayers = [{ id: "layer-1", text: "Done" } as any];
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});

		render(WorkspacePagesView);

		const nextAction = screen.getByRole("region", { name: "งานถัดไปในหน้า" });
		await fireEvent.click(within(nextAction).getByRole("button", { name: "คัดลอกลิงก์" }));

		expect(writeText).toHaveBeenCalledWith("http://localhost:3000/projects/project-1/pages/2/editor");
		expect(projectStore.statusMsg).toBe("คัดลอกลิงก์หน้าแล้ว");
		expect(window.location.pathname).toBe("/projects/project-1/pages");
	});

	it("stays on the page queue when save-blocked page opening fails", async () => {
		window.history.replaceState({}, "", "/projects/project-1/pages");
		projectStore.__setProjectForTesting(project());
		editorUiStore.openPages();
		editorStore.textLayers = [{ id: "layer-1", text: "Done" } as any];
		vi.spyOn(projectStore, "goToPage").mockResolvedValue(false);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspacePagesView);

		const chapterQueue = screen.getByRole("region", { name: "หน้าในตอน" });
		await fireEvent.click(within(chapterQueue).getByRole("button", { name: "เปิดหน้า 2: รอรีวิวผล" }));

		expect(projectStore.goToPage).toHaveBeenCalledWith(1, null);
		expect(editorStore.refreshTextLayers).not.toHaveBeenCalled();
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("pages"));
		expect(window.location.pathname).toBe("/projects/project-1/pages");
	});

	it("opens the import review route from the pages surface", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openPages();

		render(WorkspacePagesView);

		await fireEvent.click(screen.getByRole("button", { name: "Import ข้อความ" }));

		await waitFor(() => expect(editorUiStore.workspaceView).toBe("import"));
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/import"));
	});

	// Focus mode was removed: the pages "ดูงานค้าง" affordance now opens the team Work Board.
	it("opens the team work board from the pages surface", async () => {
		projectStore.__setProjectForTesting(project());
		editorUiStore.openPages();

		render(WorkspacePagesView);

		await fireEvent.click(screen.getAllByRole("button", { name: "ดูงานค้าง" })[0]);

		await waitFor(() => expect(editorUiStore.workspaceView).toBe("work"));
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/work"));
	});

	it("surfaces persistent image recovery directly on the pages surface", () => {
		projectStore.__setProjectForTesting(project());
		projectStore.assetLoadErrors = {
			1: {
				pageIndex: 1,
				imageId: "image-2",
				imageName: "page-2.png",
				message: "Image returned 404",
			},
		};
		editorUiStore.openPages();

		render(WorkspacePagesView);

		const recovery = screen.getByRole("region", { name: "กู้รูปบนหน้า" });
		expect(within(recovery).getByText((_content, element) =>
			element?.tagName.toLowerCase() === "strong"
			&& (element.textContent?.replace(/\s+/g, " ").trim() ?? "") === "1 หน้าต้องกู้รูป",
		)).toBeTruthy();
		expect(within(recovery).getByText("โหลดรูปไม่สำเร็จ")).toBeTruthy();
		expect(within(recovery).getByText("Image returned 404")).toBeTruthy();
		expect(within(recovery).getByRole("button", { name: "จับคู่รูปทั้งตอน" })).toBeTruthy();
		expect(within(recovery).getByRole("button", { name: "ตรวจหน้า 2" })).toBeTruthy();
		expect(within(recovery).getByRole("button", { name: "กู้รูปหน้า 2" })).toBeTruthy();
	});

	it("labels image-layer recovery as a layer relink instead of a base-page relink", () => {
		projectStore.__setProjectForTesting(project());
		projectStore.assetLoadErrors = {
			0: {
				pageIndex: 0,
				imageId: "missing-overlay",
				imageName: "overlay.png",
				originalName: "overlay-source.png",
				message: "404 overlay",
				kind: "image-layer",
				layerId: "overlay-layer",
				layerName: "Logo overlay",
			},
		};
		editorUiStore.openPages();

		render(WorkspacePagesView);

		const recovery = screen.getByRole("region", { name: "กู้รูปบนหน้า" });
		expect(within(recovery).getByText("รูปเสริม Logo overlay โหลดไม่ได้: 404 overlay")).toBeTruthy();
		expect(within(recovery).getByRole("button", { name: "กู้รูปเสริม" })).toBeTruthy();
		expect(within(recovery).queryByRole("button", { name: "กู้รูปหน้า 1" })).toBeNull();
	});

	it("shows every missing image layer issue on the same page", () => {
		projectStore.__setProjectForTesting(project());
		projectStore.assetLoadErrors = {
			0: [
				{
					pageIndex: 0,
					imageId: "missing-overlay-a",
					imageName: "overlay-a.png",
					originalName: "first-overlay.png",
					message: "404 first",
					kind: "image-layer",
					layerId: "overlay-a",
					layerName: "First overlay",
				},
				{
					pageIndex: 0,
					imageId: "missing-overlay-b",
					imageName: "overlay-b.png",
					originalName: "second-overlay.png",
					message: "404 second",
					kind: "image-layer",
					layerId: "overlay-b",
					layerName: "Second overlay",
				},
			],
		};
		editorUiStore.openPages();

		render(WorkspacePagesView);

		const recovery = screen.getByRole("region", { name: "กู้รูปบนหน้า" });
		const issueList = within(recovery).getByRole("group", { name: "รูปที่ต้องกู้หน้า 1" });
		expect(within(issueList).getByText((_content, element) =>
			element?.tagName.toLowerCase() === "em"
			&& (element.textContent?.replace(/\s+/g, " ").trim() ?? "") === "2 รายการในหน้านี้",
		)).toBeTruthy();
		expect(within(issueList).getByRole("button", { name: "First overlay" })).toBeTruthy();
		expect(within(issueList).getByRole("button", { name: "Second overlay" })).toBeTruthy();
	});

	it("keeps all-stale export history visible without allowing a wrong retry", () => {
		const state = project();
		state.exportRuns = [{
			id: "export-stale",
			kind: "single-page",
			status: "error",
			filename: "page-5.png",
			pageIndexes: [4],
			pageCount: 1,
			message: "Export failed.",
			error: "Page was deleted",
			createdAt: now,
			completedAt: now,
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openPages();

		render(WorkspacePagesView);

		const history = screen.getByRole("region", { name: "ประวัติ Export ล่าสุด" });
		expect(within(history).getByText("Export ล่าสุด")).toBeTruthy();
		const summary = within(history).getByText("Export ล่าสุด").closest("summary");
		expect(summary?.textContent?.replace(/\s+/g, " ")).toContain("ล้มเหลว 1 / กดเพื่อเปิด/ปิดประวัติ Export");
		expect(summary?.textContent).not.toContain("Export ไม่สำเร็จ");
		expect(summary?.textContent).not.toContain("หน้านี้ถูกลบแล้ว");
		expect(within(history).getByText("page-5.png")).toBeTruthy();
		expect(within(history).getByText(/1 หน้าไม่ได้อยู่ในงานนี้แล้ว/)).toBeTruthy();
		expect(within(history).getByText(/Export ไม่สำเร็จ: หน้านี้ถูกลบแล้ว/)).toBeTruthy();
		expect(within(history).queryByRole("button", { name: "เปิดหน้า" })).toBeNull();
		expect(within(history).getByText("หน้าไม่อยู่แล้ว").getAttribute("title")).toBe("หน้าในประวัติ Export ไม่อยู่ในงานนี้แล้ว");
		expect(within(history).queryByRole("button", { name: "ทำ PNG ใหม่" })).toBeNull();
		expect(within(history).getByText("ทำใหม่หลังเคลียร์").getAttribute("title")).toBe("หน้าในประวัติ Export ไม่อยู่ในงานนี้แล้ว");
	});

	it("retries only remaining live pages from pages export history", async () => {
		const state = project();
		state.exportRuns = [{
			id: "export-mixed",
			kind: "batch-zip",
			status: "error",
			filename: "chapter.zip",
			pageIndexes: [0, 4],
			pageCount: 2,
			message: "Batch export failed.",
			createdAt: now,
			completedAt: now,
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openPages();
		const retryExportRun = vi.spyOn(projectStore, "retryExportRun").mockResolvedValue();

		render(WorkspacePagesView);

		const history = screen.getByRole("region", { name: "ประวัติ Export ล่าสุด" });
		expect(within(history).getByText("chapter.zip")).toBeTruthy();
		expect(within(history).getByText(/1 หน้าไม่ได้อยู่ในงานนี้แล้ว/)).toBeTruthy();
		expect((within(history).getByRole("button", { name: "เปิดหน้า" }) as HTMLButtonElement).disabled).toBe(false);

		await fireEvent.click(within(history).getByRole("button", { name: "ทำ ZIP ใหม่" }));

		expect(retryExportRun).toHaveBeenCalledWith("export-mixed", undefined, [0]);
	});

	it("opens the page named by a failed export instead of the first export page", async () => {
		const state = project();
		state.tasks = [];
		state.pages[1].textLayers = [{ id: "layer-2", text: "Done too" } as any];
		state.exportRuns = [{
			id: "export-failed-page-2",
			kind: "batch-zip",
			status: "error",
			filename: "chapter.zip",
			pageIndexes: [0, 1],
			pageCount: 2,
			message: "Export ไม่สำเร็จ: หน้า 2; ทำสำเร็จแล้ว 1/2 ในชุด หน้า 1-2 - renderer lost layer image",
			error: "หน้า 2; ทำสำเร็จแล้ว 1/2 ในชุด หน้า 1-2 - renderer lost layer image",
			createdAt: now,
			completedAt: now,
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openPages();
		editorStore.textLayers = [{ id: "layer-1", text: "Done" } as any];
		vi.spyOn(projectStore, "goToPage").mockResolvedValue(true);
		vi.spyOn(editorStore, "refreshTextLayers").mockImplementation(() => {});

		render(WorkspacePagesView);

		const history = screen.getByRole("region", { name: "ประวัติ Export ล่าสุด" });
		const openPageButton = within(history).getByRole("button", { name: "เปิดหน้า" });
		expect(openPageButton.getAttribute("title")).toBe("เปิดหน้า 2 ที่ Export แจ้งปัญหา");

		await fireEvent.click(openPageButton);

		expect(projectStore.goToPage).toHaveBeenCalledWith(1, null);
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/pages/2/editor"));
		expect(projectStore.statusMsg).toBe("เปิดหน้า 2 ที่ Export แจ้งปัญหาแล้ว");
	});

	it("keeps export history retry locked when required public credit is missing", async () => {
		const state = project();
		state.tasks = [];
		state.creditPolicy = "required";
			state.exportRuns = [{
				id: "export-public",
				kind: "batch-zip",
				status: "error",
				targetProfile: "public-export",
				filename: "public-chapter.zip",
				pageIndexes: [0, 1],
			pageCount: 2,
			message: "Previous export failed.",
			createdAt: now,
			completedAt: now,
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openPages();
		editorStore.textLayers = [{ id: "layer-1", text: "Done" } as any];

		render(WorkspacePagesView);

		const history = screen.getByRole("region", { name: "ประวัติ Export ล่าสุด" });
		expect(within(history).queryByRole("button", { name: "ทำ ZIP ใหม่" })).toBeNull();
		expect(within(history).getByText("ทำใหม่หลังเคลียร์").getAttribute("title")).toBe("ส่งออกยังไม่พร้อม: เผยแพร่/ส่งออก ต้องมีเครดิตอย่างน้อย 1 รายการในตอนนี้");
		expect(within(history).getByText("public-chapter.zip")).toBeTruthy();
		expect(within(history).getByText(/เผยแพร่\/ส่งออก \/ ZIP ทั้งชุด/)).toBeTruthy();

		const creditFocusTokenBefore = editorUiStore.creditToolsFocusToken;
		await fireEvent.click(within(history).getByRole("button", { name: "เปิดเครดิต" }));

		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorUiStore.creditToolsFocusToken).toBe(creditFocusTokenBefore + 1);
		await waitFor(() => expect(editorUiStore.workspaceView).toBe("editor"));
		expect(window.location.pathname).toBe("/projects/project-1/pages/1/editor");
		expect(projectStore.statusMsg).toBe("เปิดเครื่องมือเครดิตในแผงเลเยอร์แล้ว");
	});

	it("explains that export history retry is locked while a batch export is running", () => {
		const state = project();
		state.exportRuns = [{
			id: "export-running",
			kind: "batch-zip",
			status: "error",
			filename: "chapter.zip",
			pageIndexes: [0],
			pageCount: 1,
			message: "Batch export failed.",
			createdAt: now,
			completedAt: now,
		}];
		projectStore.__setProjectForTesting(state);
		projectStore.batchExportStatus = "exporting";
		editorUiStore.openPages();

		render(WorkspacePagesView);

		const history = screen.getByRole("region", { name: "ประวัติ Export ล่าสุด" });
		expect(within(history).queryByRole("button", { name: "ทำ ZIP ใหม่" })).toBeNull();
		expect(within(history).getByText("กำลัง Export").getAttribute("title")).toBe("กำลัง Export อยู่");
	});

	it("downloads a session-available batch export from pages history", async () => {
		const state = project();
		state.exportRuns = [{
			id: "export-done",
			kind: "batch-zip",
			status: "done",
			filename: "chapter.zip",
			pageIndexes: [0],
			pageCount: 1,
			message: "Exported chapter.zip",
			artifactError: "Stored ZIP was not saved: Workspace storage is full.",
			createdAt: now,
			completedAt: now,
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openPages();
		vi.spyOn(projectStore, "canDownloadExportRun").mockReturnValue(true);
		const downloadExportRun = vi.spyOn(projectStore, "downloadExportRun").mockImplementation(() => {});

		render(WorkspacePagesView);

		const history = screen.getByRole("region", { name: "ประวัติ Export ล่าสุด" });
		const downloadButton = within(history).getByRole("button", { name: "ดาวน์โหลด" });
		expect(downloadButton.getAttribute("title")).toBe("ดาวน์โหลด chapter.zip");
		await fireEvent.click(downloadButton);

		expect(downloadExportRun).toHaveBeenCalledWith("export-done");
	});

	it("removes a persisted batch export artifact from pages history", async () => {
		const state = project();
		state.exportRuns = [{
			id: "export-done",
			kind: "batch-zip",
			status: "done",
			filename: "chapter.zip",
			pageIndexes: [0],
			pageCount: 1,
			message: "Exported chapter.zip",
			createdAt: now,
			completedAt: now,
			artifact: {
				exportId: "export-done.zip",
				storageDriver: "local",
				storageKey: "projects/project-1/exports/export-done.zip",
				filename: "chapter.zip",
				mimeType: "application/zip",
				sizeBytes: 7,
				createdAt: now,
			},
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openPages();
		const deleteExportArtifact = vi.spyOn(projectStore, "deleteExportArtifact").mockResolvedValue();

		render(WorkspacePagesView);

		const history = screen.getByRole("region", { name: "ประวัติ Export ล่าสุด" });
		const removeButton = within(history).getByRole("button", { name: "ลบ ZIP" });
		expect(removeButton.getAttribute("title")).toBe("ลบ ZIP ที่เก็บไว้ของ chapter.zip เพื่อคืน storage");
		expect(within(history).getByText("เก็บ ZIP แล้ว / นับใน storage")).toBeTruthy();
		await fireEvent.click(removeButton);

		expect(deleteExportArtifact).toHaveBeenCalledWith("export-done");
	});

	it("keeps older retained export artifacts visible for cleanup", () => {
		const state = project();
		state.exportRuns = [
			...Array.from({ length: 4 }, (_, index) => ({
				id: `export-recent-${index}`,
				kind: "batch-zip" as const,
				status: "done" as const,
				filename: `recent-${index}.zip`,
				pageIndexes: [0],
				pageCount: 1,
				message: `Exported recent-${index}.zip`,
				createdAt: now,
				completedAt: now,
			})),
			{
				id: "export-retained-old",
				kind: "batch-zip",
				status: "done",
				filename: "old-stored.zip",
				pageIndexes: [0],
				pageCount: 1,
				message: "Exported old-stored.zip",
				createdAt: now,
				completedAt: now,
				artifact: {
					exportId: "old-stored.zip",
					storageDriver: "local",
					storageKey: "projects/project-1/exports/old-stored.zip",
					filename: "old-stored.zip",
					mimeType: "application/zip",
					sizeBytes: 7,
					createdAt: now,
				},
			},
		];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openPages();

		render(WorkspacePagesView);

		const history = screen.getByRole("region", { name: "ประวัติ Export ล่าสุด" });
		expect(within(history).getByText("old-stored.zip")).toBeTruthy();
		expect(within(history).getByRole("button", { name: "ลบ ZIP" })).toBeTruthy();
	});

	it("opens export history when Pages is entered for stored export cleanup", () => {
		const state = project();
		state.exportRuns = [{
			id: "export-done",
			kind: "batch-zip",
			status: "done",
			filename: "chapter.zip",
			pageIndexes: [0],
			pageCount: 1,
			message: "Exported chapter.zip",
			createdAt: now,
			completedAt: now,
			artifact: {
				exportId: "chapter.zip",
				storageDriver: "local",
				storageKey: "projects/project-1/exports/chapter.zip",
				filename: "chapter.zip",
				mimeType: "application/zip",
				sizeBytes: 7,
				createdAt: now,
			},
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openPages({ exportHistory: true });

		render(WorkspacePagesView);

		const history = screen.getByRole("region", { name: "ประวัติ Export ล่าสุด" }) as HTMLDetailsElement;
		expect(history.open).toBe(true);
		expect(within(history).getByRole("button", { name: "ลบ ZIP" })).toBeTruthy();
	});

	it("disables batch export download when the session blob is gone", () => {
		const state = project();
		state.exportRuns = [{
			id: "export-done",
			kind: "batch-zip",
			status: "done",
			filename: "chapter.zip",
			pageIndexes: [0],
			pageCount: 1,
			message: "Exported chapter.zip",
			artifactError: "Stored ZIP was not saved: Workspace storage is full.",
			createdAt: now,
			completedAt: now,
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openPages();

		render(WorkspacePagesView);

		const history = screen.getByRole("region", { name: "ประวัติ Export ล่าสุด" });
		const downloadReceipt = within(history).getByText("ดาวน์โหลดยังไม่พร้อม");
		expect(within(history).getByText("เก็บ ZIP ไม่สำเร็จ / สร้างใหม่หลังคืนพื้นที่")).toBeTruthy();
		expect(within(history).getByText("เก็บ ZIP ไม่สำเร็จ: Storage ของเวิร์กสเปซเต็ม")).toBeTruthy();
		expect(downloadReceipt.getAttribute("title")).toBe(
			"ไฟล์อยู่เฉพาะ session นี้ กดสร้างใหม่เพื่อ Export อีกครั้ง",
		);
		expect(within(history).queryByRole("button", { name: "ดาวน์โหลด" })).toBeNull();
	});

	it("opens export history when a completed run needs artifact recovery", () => {
		const state = project();
		state.exportRuns = [{
			id: "export-missing-artifact",
			kind: "batch-zip",
			status: "done",
			filename: "chapter.zip",
			pageIndexes: [0],
			pageCount: 1,
			message: "Exported chapter.zip",
			artifactError: "ไฟล์ ZIP ที่เคยเก็บไว้หาไม่เจอ: สร้าง Export ใหม่อีกครั้ง",
			createdAt: now,
			completedAt: now,
		}];
		projectStore.__setProjectForTesting(state);
		editorUiStore.openPages();

		render(WorkspacePagesView);

		const history = screen.getByRole("region", { name: "ประวัติ Export ล่าสุด" }) as HTMLDetailsElement;
		expect(history.open).toBe(true);
		expect(within(history).getByText("ดาวน์โหลดยังไม่พร้อม")).toBeTruthy();
		expect(within(history).getByRole("button", { name: "ทำ ZIP ใหม่" })).toBeTruthy();
	});
});
