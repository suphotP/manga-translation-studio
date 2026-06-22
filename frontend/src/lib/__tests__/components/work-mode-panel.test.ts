import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import WorkModePanel from "$lib/components/WorkModePanel.svelte";
import { editorStore } from "$lib/stores/editor.svelte.ts";
import { editorUiStore } from "$lib/stores/editor-ui.svelte.ts";
import { projectStore } from "$lib/stores/project.svelte.ts";
import type {
	ActivityEvent,
	AiReviewMarker,
	Page,
	PageReviewDecision,
	ProjectComment,
	ProjectState,
	TextLayer,
	VersionReviewRequest,
	WorkflowTask,
	WorkspaceFeedItem,
} from "$lib/types.js";

const now = "2026-05-12T12:34:00.000Z";

function textLayer(overrides: Partial<TextLayer> = {}): TextLayer {
	return {
		id: "layer-1",
		text: "Translated line",
		x: 10,
		y: 20,
		w: 160,
		h: 48,
		rotation: 0,
		fontSize: 24,
		alignment: "center",
		index: 0,
		...overrides,
	};
}

function page(overrides: Partial<Page> = {}): Page {
	return {
		imageId: "image-1.webp",
		imageName: "image-1.webp",
		textLayers: [textLayer()],
		pendingAiJobs: [],
		coverRect: null,
		...overrides,
	};
}

function comment(overrides: Partial<ProjectComment> = {}): ProjectComment {
	return {
		id: "comment-1",
		pageIndex: 0,
		layerId: "layer-1",
		body: "Please check this line",
		author: "lead",
		mentions: ["letterer"],
		status: "open",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function task(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
	return {
		id: "task-1",
		type: "typeset",
		status: "doing",
		priority: "normal",
		pageIndex: 0,
		title: "Typeset page",
		assignee: "maya",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function aiReviewMarker(overrides: Partial<AiReviewMarker> = {}): AiReviewMarker {
	return {
		id: "ai-marker-1",
		jobId: "job-1",
		pageIndex: 0,
		imageId: "image-1.webp",
		region: { x: 10, y: 20, w: 120, h: 80 },
		status: "processing",
		tier: "sfx_pro",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function reviewDecision(overrides: Partial<PageReviewDecision> = {}): PageReviewDecision {
	return {
		id: "review-1",
		pageIndex: 0,
		status: "changes_requested",
		body: "Needs fixes",
		actor: "lead",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function activityEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
	return {
		id: "activity-1",
		type: "task_updated",
		message: "Task moved to review",
		actor: "lead",
		createdAt: now,
		...overrides,
	};
}

function versionReviewRequest(overrides: Partial<VersionReviewRequest> = {}): VersionReviewRequest {
	return {
		id: "version-review-1",
		versionId: "version-1",
		status: "open",
		body: "Check snapshot",
		requester: "lead",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function workspaceFeedItem(overrides: Partial<WorkspaceFeedItem> = {}): WorkspaceFeedItem {
	return {
		id: "feed-1",
		kind: "version_review",
		sourceId: "version-review-1",
		versionId: "version-1",
		pageIndex: 0,
		title: "Version needs review",
		detail: "Open the saved snapshot",
		createdAt: now,
		severity: "warning",
		...overrides,
	};
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
	const layer = textLayer();
	const projectComment = comment({ layerId: layer.id });
	const projectTask = task();
	const projectReviewDecision = reviewDecision();
	const projectActivity = activityEvent();
	return {
		projectId: "project-1",
		name: "Work mode test",
		createdAt: now,
		pages: [page({ textLayers: [layer] })],
		currentPage: 0,
		targetLang: "en",
		tasks: [projectTask],
		activityLog: [projectActivity],
		comments: [projectComment],
		aiReviewMarkers: [],
		reviewDecisions: [projectReviewDecision],
		workspaceMessages: [],
		versionReviewRequests: [versionReviewRequest()],
		...overrides,
	};
}

function resetStores(): void {
	projectStore.__resetForTesting();
	editorUiStore.__resetForTesting();
	projectStore.workspaceFeed = [];
	projectStore.workspaceMessages = [];
	editorStore.currentTool = "select";
	editorStore.selectedLayer = null;
	editorStore.textLayers = [];
	editorStore.editor = null;
	editorStore.hasImage = false;
}

beforeEach(() => {
	resetStores();
});

async function openWorkSection(label: string): Promise<void> {
	const alreadyOpen = screen.queryByRole("button", { name: `${label} เปิดอยู่` });
	if (alreadyOpen) return;
	const directClosed = screen.queryByRole("button", { name: `${label} ปิดอยู่` });
	if (directClosed) {
		await fireEvent.click(directClosed);
		return;
	}
	const switcherSummary = screen.queryByText("สลับหมวด");
	if (switcherSummary) {
		await fireEvent.click(switcherSummary);
	}
	const switcher = screen.getByRole("group", { name: "สลับหมวดงาน" });
	await fireEvent.click(within(switcher).getByRole("button", { name: new RegExp(`^${label}`) }));
	await waitFor(() => expect(screen.getByRole("button", { name: `${label} เปิดอยู่` })).toBeTruthy());
}

describe("WorkModePanel", () => {
	it("renders closed-project work sections without requiring parent orchestration", async () => {
		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		expect(screen.getByRole("button", { name: "งานด่วน ปิดอยู่" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "อัปเดตทีม ปิดอยู่" })).toBeNull();
		expect(screen.getByRole("group", { name: "รายละเอียดงานเพิ่มเติม" })).toBeTruthy();
		expect(screen.queryByText("งานทีม / ขั้นสูง")).toBeNull();
		expect(screen.getByRole("button", { name: "เช็กคุณภาพ ปิดอยู่" })).toBeTruthy();
		expect(screen.getByRole("button", { name: /หน้าแรก/ })).toBeTruthy();
		// Focus mode was removed: the per-task "เพิ่มเติม / ทำทีละงาน" submenu is gone.
		expect(screen.queryByText("เพิ่มเติม")).toBeNull();
		expect(screen.queryByRole("button", { name: /ทำทีละงาน/ })).toBeNull();
		expect(screen.getByText("งานของหน้านี้")).toBeTruthy();
		expect(screen.getByText("ยังไม่ได้เปิดงาน")).toBeTruthy();
		expect(screen.getAllByText("เปิดเวิร์กสเปซก่อน").length).toBeGreaterThanOrEqual(1);
		expect(screen.queryByText("เปิด Project เพื่อดูและเขียน Comment ของหน้านี้")).toBeNull();
		expect(screen.queryByText("เปิดงานเพื่อจัดการงานผลิต")).toBeNull();
	});

	it("keeps hidden solo advanced sections out of normal section switching", async () => {
		projectStore.__setProjectForTesting(project());

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		await openWorkSection("งานด่วน");
		await fireEvent.click(screen.getByText("สลับหมวด"));
		const switcher = screen.getByRole("group", { name: "สลับหมวดงาน" });
		expect(within(switcher).queryByText("ประวัติงาน")).toBeNull();
		expect(within(switcher).queryByText("ขั้นงานละเอียด")).toBeNull();
		expect(within(switcher).getByText("รีวิวผล AI")).toBeTruthy();
		expect(within(switcher).getByText("เช็กก่อน Export")).toBeTruthy();
	});

	// Focus mode was removed: the inspector now exits only into the full Work Board
	// (the per-task "ทำทีละงาน" Focus submenu is gone).
	it("offers an exit from the inspector into the full Work Board surface", async () => {
		projectStore.__setProjectForTesting(project());
		projectStore.workspaceFeed = [];

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		editorUiStore.setWorkspaceView("editor");
		await fireEvent.click(screen.getByRole("button", { name: /ดูงานทั้งหมด/ }));
		expect(editorUiStore.workspaceView).toBe("work");
		await waitFor(() => expect(window.location.pathname).toBe("/projects/project-1/work"));

		expect(screen.queryByText("เพิ่มเติม")).toBeNull();
	});

	it("shows AI placement debt in the section meter instead of claiming ready", () => {
		projectStore.__setProjectForTesting(project({
			tasks: [],
			comments: [],
			reviewDecisions: [],
			workspaceMessages: [],
			versionReviewRequests: [],
			aiReviewMarkers: [aiReviewMarker({
				status: "accepted",
				resultImageId: "result-ai-1.webp",
			})],
		}));

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		const aiHeader = screen.getByRole("button", { name: "รีวิวผล AI ปิดอยู่" });
		expect(within(aiHeader).getByText("1 รอวาง")).toBeTruthy();
		expect(within(aiHeader).queryByText("พร้อม")).toBeNull();
		expect(screen.getByText("AI รอวาง")).toBeTruthy();
	});

	it("routes inbox rows to the canvas selection and version feed rows to the project callback", async () => {
		editorUiStore.setWorkspaceMode("team");
		const layer = textLayer();
		const onOpenVersionReview = vi.fn();
		const onOpenProjectPages = vi.fn();
		projectStore.__setProjectForTesting(project({
			pages: [page({ textLayers: [layer] })],
			comments: [comment({ layerId: layer.id })],
		}));
		projectStore.workspaceFeed = [workspaceFeedItem()];
		editorStore.textLayers = [layer];
		editorStore.editor = {
			selectTextLayer: vi.fn(() => layer),
			getCoverCrop: vi.fn(() => null),
			setTool: vi.fn(),
		};

		render(WorkModePanel, {
			props: {
				onOpenVersionReview,
				onOpenProjectPages,
			},
		});

		await openWorkSection("งานด่วน");
		expect(screen.getAllByText("Please check this line").length).toBeGreaterThanOrEqual(1);
		await fireEvent.click(screen.getAllByRole("button", { name: /เปิดงานด่วน/ })[0]);
		expect(projectStore.selectedProjectCommentId).toBe("comment-1");
		expect(editorStore.selectedLayer?.id).toBe(layer.id);

		await openWorkSection("อัปเดตทีม");
		expect(screen.getByText("Version needs review")).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: /Version needs review/ }));
		expect(onOpenVersionReview).toHaveBeenCalledWith("version-1");
	});

	it("opens the matching work section when an external focus target is selected", async () => {
		editorUiStore.setRightPanelMode("work");
		projectStore.__setProjectForTesting(project({
			aiReviewMarkers: [aiReviewMarker({ id: "ai-marker-1", status: "needs_review" })],
		}));

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		projectStore.selectProjectComment("comment-1");

		await waitFor(() => expect(screen.getByRole("button", { name: "โน้ต เปิดอยู่" })).toBeTruthy());
		expect(screen.getByRole("button", { name: "รีวิวผล AI ปิดอยู่" })).toBeTruthy();

		projectStore.selectProjectComment(null);
		projectStore.selectAiReviewMarker("ai-marker-1");

		await waitFor(() => expect(screen.getByRole("button", { name: "รีวิวผล AI เปิดอยู่" })).toBeTruthy());
		expect(screen.getByRole("button", { name: "โน้ต ปิดอยู่" })).toBeTruthy();
	});

	it("does not select a work target when the page switch is blocked", async () => {
		const layer = textLayer({ id: "layer-page-2" });
		const goToPage = vi.spyOn(projectStore, "goToPage").mockResolvedValue(false);
		projectStore.__setProjectForTesting(project({
			pages: [
				page({ imageId: "image-1.webp", imageName: "image-1.webp", textLayers: [textLayer({ id: "layer-current" })] }),
				page({ imageId: "image-2.webp", imageName: "image-2.webp", textLayers: [layer] }),
			],
			comments: [comment({
				id: "comment-page-2",
				pageIndex: 1,
				layerId: layer.id,
				body: "Blocked page comment",
			})],
			tasks: [],
			reviewDecisions: [],
		}));
		editorStore.editor = {
			selectTextLayer: vi.fn(() => layer),
			getCoverCrop: vi.fn(() => null),
			setTool: vi.fn(),
		};
		editorStore.textLayers = [layer];

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		await openWorkSection("งานด่วน");
		await fireEvent.click(screen.getByRole("button", { name: "ทั้งหมด" }));
		expect(screen.getByText("Blocked page comment")).toBeTruthy();
		await fireEvent.click(screen.getByText("Blocked page comment"));

		expect(goToPage).toHaveBeenCalledWith(1, editorStore.editor);
		expect(projectStore.selectedProjectCommentId).toBeNull();
		expect(editorStore.selectedLayer).toBeNull();
	});

	it("does not select stale workspace feed targets whose source record was removed", async () => {
		editorUiStore.setWorkspaceMode("team");
		projectStore.__setProjectForTesting(project({
			comments: [],
			tasks: [],
			aiReviewMarkers: [],
			reviewDecisions: [],
			versionReviewRequests: [],
		}));
		projectStore.workspaceFeed = [workspaceFeedItem({
			id: "deleted-task-feed",
			kind: "task",
			sourceId: "deleted-task",
			pageIndex: 0,
			title: "Deleted task",
			detail: "This task no longer exists",
		})];

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		await openWorkSection("อัปเดตทีม");
		await fireEvent.click(screen.getByRole("button", { name: /Deleted task/ }));

		expect(projectStore.selectedWorkflowTaskId).toBeNull();
			expect(projectStore.statusMsg).toBe("งานนี้ไม่มีแล้ว");
	});

	it("routes workspace feed targets with missing pages into their repair section", async () => {
		editorUiStore.setWorkspaceMode("team");
		projectStore.__setProjectForTesting(project({
			pages: [page()],
			comments: [],
			tasks: [task({
				id: "task-missing-page",
				pageIndex: 4,
				title: "Clean deleted page",
			})],
			aiReviewMarkers: [],
			reviewDecisions: [],
			versionReviewRequests: [],
		}));
		projectStore.workspaceFeed = [workspaceFeedItem({
			id: "task-missing-page-feed",
			kind: "task",
			sourceId: "task-missing-page",
			pageIndex: 4,
			title: "Clean deleted page",
			detail: "Task points at a deleted page",
		})];

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		await openWorkSection("อัปเดตทีม");
		await fireEvent.click(within(screen.getByRole("group", { name: "ขอบเขตอัปเดตทีม" })).getByRole("button", { name: "ทั้งหมด" }));
		await fireEvent.click(screen.getByRole("button", { name: /Clean deleted หน้า/ }));

		expect(projectStore.project?.currentPage).toBe(0);
		expect(projectStore.selectedWorkflowTaskId).toBe("task-missing-page");
		expect(projectStore.statusMsg).toBe("หน้างานผลิตหาย; ย้ายไปหน้าที่ถูกต้องหรือปิดงานนี้");
		await waitFor(() => expect(screen.getByRole("button", { name: "งานผลิต เปิดอยู่" })).toBeTruthy());
	});

	it("routes export feed rows to the project pages callback", async () => {
		editorUiStore.setWorkspaceMode("team");
		const onOpenProjectPages = vi.fn();
		projectStore.__setProjectForTesting(project({
			workspaceMessages: [],
			activityLog: [],
			comments: [],
			reviewDecisions: [],
			versionReviewRequests: [],
			tasks: [],
		}));
		projectStore.workspaceFeed = [workspaceFeedItem({
			id: "export-run-1",
			kind: "export_run",
			sourceId: "export-1",
			versionId: undefined,
			pageIndex: undefined,
			title: "Export failed",
			detail: "2 pages / Page 2 has holds",
			severity: "error",
			status: "error",
		})];

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages,
			},
		});

		await openWorkSection("อัปเดตทีม");
		await fireEvent.click(within(screen.getByRole("group", { name: "ขอบเขตอัปเดตทีม" })).getByRole("button", { name: "ทั้งหมด" }));
		await fireEvent.click(screen.getByRole("button", { name: /Export ล้มเหลว/ }));
		expect(onOpenProjectPages).toHaveBeenCalled();
			expect(projectStore.statusMsg).toBe("เปิดประวัติ Export แล้ว");
	});

	it("routes stale single-page export feed rows to history instead of a missing page", async () => {
		editorUiStore.setWorkspaceMode("team");
		const onOpenProjectPages = vi.fn();
		projectStore.__setProjectForTesting(project({
			pages: [page({ imageName: "page-1.webp" })],
			workspaceMessages: [],
			activityLog: [],
			comments: [],
			reviewDecisions: [],
			versionReviewRequests: [],
			tasks: [],
		}));
		projectStore.workspaceFeed = [workspaceFeedItem({
			id: "export-run-stale",
			kind: "export_run",
			sourceId: "export-stale",
			versionId: undefined,
			pageIndex: 4,
			title: "Export failed",
			detail: "1 page / Page 5 was deleted",
			severity: "error",
			status: "error",
		})];

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages,
			},
		});

		await openWorkSection("อัปเดตทีม");
		await fireEvent.click(within(screen.getByRole("group", { name: "ขอบเขตอัปเดตทีม" })).getByRole("button", { name: "ทั้งหมด" }));
		await fireEvent.click(screen.getByRole("button", { name: /Export ล้มเหลว/ }));

		expect(onOpenProjectPages).toHaveBeenCalled();
		expect(projectStore.project?.currentPage).toBe(0);
			expect(projectStore.statusMsg).toBe("หน้าใน Export history ไม่มีแล้ว; เปิดประวัติ Export ให้ตรวจ");
	});

	it("defaults new comments to a page note so the composer is usable without selecting a layer", async () => {
		projectStore.__setProjectForTesting(project({
			comments: [],
			reviewDecisions: [],
			tasks: [],
		}));

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		await openWorkSection("โน้ต");
		expect(screen.getAllByText("ทั้งหน้า").length).toBeGreaterThan(0);
		expect((screen.getByRole("radio", { name: "ทั้งหน้า" }) as HTMLInputElement).checked).toBe(true);

		await fireEvent.input(screen.getByLabelText("โน้ตใหม่ของหน้านี้"), {
			target: { value: "Quick page note" },
		});

		expect((screen.getByRole("button", { name: "เพิ่มโน้ต" }) as HTMLButtonElement).disabled).toBe(false);
	});

	it("surfaces AI review before generic workflow tasks when no higher-priority inbox or QC blocker exists", () => {
		projectStore.__setProjectForTesting(project({
			comments: [],
			reviewDecisions: [],
			aiReviewMarkers: [aiReviewMarker()],
			tasks: [task({ assignee: undefined, priority: "normal", status: "doing" })],
		}));

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		expect(screen.getAllByText("รีวิวผล AI").length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText("1 ผล AI ยังต้องเช็กก่อน Export.").length).toBeGreaterThanOrEqual(1);
	});

	it("opens inbox AI results by selecting the marker and focusing its canvas region", async () => {
		const focusImageRegion = vi.fn();
		const region = { x: 32, y: 48, w: 180, h: 120 };
		projectStore.__setProjectForTesting(project({
			comments: [],
			reviewDecisions: [],
			tasks: [],
			versionReviewRequests: [],
			aiReviewMarkers: [aiReviewMarker({
				id: "needs-review-marker",
				status: "needs_review",
				region,
				resultImageId: "result-ai.webp",
			})],
		}));
		editorStore.editor = { focusImageRegion };

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		await openWorkSection("งานด่วน");
		await fireEvent.click(screen.getByRole("button", { name: /เปิดงานด่วน หน้า 1 - ผล AI รอรีวิว/ }));

		expect(projectStore.selectedAiReviewMarkerId).toBe("needs-review-marker");
		expect(focusImageRegion).toHaveBeenCalledWith(region);
		expect(projectStore.statusMsg).toBe("โฟกัสพื้นที่ผล AI หน้า 1 แล้ว");
		await waitFor(() => expect(screen.getByRole("button", { name: "รีวิวผล AI เปิดอยู่" })).toBeTruthy());
	});

	it("routes accepted inbox AI results into Layers placement instead of only opening the review drawer", async () => {
		const focusImageRegion = vi.fn();
		const region = { x: 14, y: 24, w: 150, h: 96 };
		projectStore.__setProjectForTesting(project({
			comments: [],
			reviewDecisions: [],
			tasks: [],
			versionReviewRequests: [],
			aiReviewMarkers: [aiReviewMarker({
				id: "accepted-unplaced-marker",
				status: "accepted",
				region,
				resultImageId: "result-ai.webp",
			})],
		}));
		editorStore.editor = { focusImageRegion };
		editorUiStore.setRightPanelMode("work");

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		await openWorkSection("งานด่วน");
		await fireEvent.click(screen.getByRole("button", { name: /เปิดงานด่วน หน้า 1 - วางผล AI เป็นเลเยอร์/ }));

		expect(projectStore.selectedAiReviewMarkerId).toBe("accepted-unplaced-marker");
		expect(focusImageRegion).toHaveBeenCalledWith(region);
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(projectStore.statusMsg).toBe("เปิดจุดวางเลเยอร์ AI หน้า 1 แล้ว");
	});

	it("opens applied AI feed targets on the exact generated layer", async () => {
		editorUiStore.setWorkspaceMode("team");
		const focusImageRegion = vi.fn();
		const selectImageLayer = vi.fn();
		const region = { x: 18, y: 28, w: 220, h: 140 };
		const marker = aiReviewMarker({
			id: "applied-marker",
			status: "applied",
			region,
			resultImageId: "result-ai.webp",
		});
		projectStore.__setProjectForTesting(project({
			pages: [page({
				imageLayers: [{
					id: "ai-result-applied-marker",
					imageId: "result-ai.webp",
					imageName: "ผล AI applied-marker.webp",
					x: 18,
					y: 28,
					w: 220,
					h: 140,
					rotation: 0,
					opacity: 1,
					index: 0,
					role: "overlay",
				}],
			})],
			comments: [],
			reviewDecisions: [],
			tasks: [],
			versionReviewRequests: [],
			aiReviewMarkers: [marker],
		}));
		projectStore.workspaceFeed = [workspaceFeedItem({
			id: "feed-ai-applied",
			kind: "ai_marker",
			sourceId: marker.id,
			versionId: undefined,
			title: "AI result placed",
			detail: "Open placed result",
		})];
		editorStore.editor = { focusImageRegion, selectImageLayer };

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		await openWorkSection("อัปเดตทีม");
		await fireEvent.click(screen.getByRole("button", { name: /เปิดอัปเดตทีม AI result placed/ }));

		expect(projectStore.selectedAiReviewMarkerId).toBe("applied-marker");
		expect(focusImageRegion).toHaveBeenCalledWith(region);
		expect(selectImageLayer).toHaveBeenCalledWith("ai-result-applied-marker");
		expect(editorUiStore.imageInspectorFocusLayerId).toBe("ai-result-applied-marker");
		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(projectStore.statusMsg).toBe("เปิดเลเยอร์ AI หน้า 1 แล้ว");
	});

	it("scopes QC counts to the current page instead of showing other-page warnings", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [
				page({ textLayers: [textLayer()] }),
				page({ textLayers: [] }),
			],
			tasks: [],
			comments: [],
			activityLog: [],
			reviewDecisions: [],
			versionReviewRequests: [],
		}));

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		await openWorkSection("เช็กคุณภาพ");
		expect(screen.getAllByText("0 ต้องเช็ก").length).toBeGreaterThan(0);
		expect(screen.getAllByText("0 ต้องเช็ก").length).toBeGreaterThan(0);
		expect(screen.getByText("ไม่มีรายการ QC ที่ต้องแก้ในหน้านี้")).toBeTruthy();
	});

	it("explains that QC items clear after the underlying page data is fixed", async () => {
		projectStore.__setProjectForTesting(project({
			pages: [page({ textLayers: [] })],
			tasks: [],
			comments: [],
			activityLog: [],
			reviewDecisions: [],
			versionReviewRequests: [],
		}));

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		await openWorkSection("เช็กคุณภาพ");

		const focusedQcIssue = screen.getByLabelText("รายการ QC ที่กำลังแก้");
			expect(within(focusedQcIssue).getByText("หน้า 1 ยังไม่มีเลเยอร์ข้อความ")).toBeTruthy();
		expect(within(focusedQcIssue).getByText("วางกล่องข้อความแรกบนหน้านี้ แล้วเช็กคุณภาพจะผ่านหลังมีข้อความ")).toBeTruthy();
		await fireEvent.click(within(focusedQcIssue).getByRole("button", { name: /วางข้อความ/ }));

		expect(editorStore.currentTool).toBe("text");
			expect(projectStore.statusMsg).toBe("คลิกรูปเพื่อวางกล่องข้อความแรก; เช็กคุณภาพจะผ่านหลังมีข้อความ");
	});

	it("routes text-layer QC fixes into the layer inspector", async () => {
		const layer = textLayer({ id: "empty-layer", text: "" });
		projectStore.__setProjectForTesting(project({
			pages: [page({ textLayers: [layer] })],
			tasks: [],
			comments: [],
			activityLog: [],
			reviewDecisions: [],
			versionReviewRequests: [],
		}));
		editorStore.textLayers = [layer];
		editorStore.editor = {
			editTextLayer: vi.fn(() => layer),
			getAllTextLayers: vi.fn(() => [layer]),
			setTool: vi.fn(),
		};

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		await openWorkSection("เช็กคุณภาพ");
		const focusedQcIssue = screen.getByLabelText("รายการ QC ที่กำลังแก้");

		expect(within(focusedQcIssue).getByText("เปิดเลเยอร์ข้อความแล้วแก้ copy ให้เรียบร้อย")).toBeTruthy();
		await fireEvent.click(within(focusedQcIssue).getByRole("button", { name: /แก้ข้อความ/ }));

		expect(editorUiStore.rightPanelMode).toBe("layers");
		expect(editorStore.selectedLayer?.id).toBe("empty-layer");
			expect(projectStore.statusMsg).toBe("เปิดเลเยอร์ข้อความจากเช็กคุณภาพเพื่อแก้แล้ว");
	});

	it("surfaces duplicate layer id QC as a repair action", async () => {
		const duplicateLayers = [
			textLayer({ id: "shared-layer", text: "First", index: 0 }),
			textLayer({ id: "shared-layer", text: "Second", index: 1, y: 90 }),
		];
		const editor = { getAllTextLayers: vi.fn(() => duplicateLayers), getAllImageLayers: vi.fn(() => []) };
		editorStore.editor = editor;
		projectStore.__setProjectForTesting(project({
			pages: [page({ textLayers: duplicateLayers })],
			tasks: [],
			comments: [],
			activityLog: [],
			reviewDecisions: [],
			versionReviewRequests: [],
		}));
		const repairSpy = vi.spyOn(projectStore, "repairDuplicateLayerIds").mockResolvedValue({
			pageIndex: 0,
			textLayerIds: 1,
			imageLayerIds: 0,
			total: 1,
		});

		try {
			render(WorkModePanel, {
				props: {
					onOpenVersionReview: vi.fn(),
					onOpenProjectPages: vi.fn(),
				},
			});

			await openWorkSection("เช็กคุณภาพ");
			const focusedQcIssue = screen.getByLabelText("รายการ QC ที่กำลังแก้");

			expect(within(focusedQcIssue).getByText("หน้า 1 มี 2 เลเยอร์ข้อความ ใช้ ID เดียวกัน; ซ่อม ID ก่อนแก้หน้านี้")).toBeTruthy();
			expect(within(focusedQcIssue).getByText("ซ่อมเฉพาะ ID เลเยอร์ที่ซ้ำ เก็บ ID แรกให้คงที่ แล้ว save/reload หน้านี้")).toBeTruthy();
			await fireEvent.click(within(focusedQcIssue).getByRole("button", { name: /ซ่อม ID/ }));

			expect(repairSpy).toHaveBeenCalledWith(0, editor);
			expect(projectStore.selectedQcIssueId).toBeNull();
		} finally {
			repairSpy.mockRestore();
		}
	});

	it("surfaces missing comment anchors as a QC path into Comments", async () => {
		projectStore.__setProjectForTesting(project({
			comments: [comment({
				id: "comment-missing-anchor",
				layerId: "deleted-layer",
				body: "Old bubble note",
			})],
			tasks: [],
			activityLog: [],
			reviewDecisions: [],
			versionReviewRequests: [],
		}));

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		await openWorkSection("เช็กคุณภาพ");
		await fireEvent.click(screen.getByRole("button", { name: "QC ถัดไป" }));
		await fireEvent.click(screen.getByRole("button", { name: "QC ถัดไป" }));

		expect(projectStore.selectedProjectCommentId).toBe("comment-missing-anchor");
		expect(projectStore.statusMsg).toBe("ตำแหน่งโน้ตหาย; ปิดหรือสร้างใหม่บน เลเยอร์ หรือพื้นที่ที่ถูกต้อง");
		await waitFor(() => expect(screen.getByRole("button", { name: "โน้ต เปิดอยู่" })).toBeTruthy());
		expect(screen.getAllByText("เลเยอร์หาย: deleted-layer").length).toBeGreaterThan(0);
	});

	it("routes stale AI marker reference QC into AI Review", async () => {
		projectStore.__setProjectForTesting(project({
			comments: [],
			tasks: [],
			aiReviewMarkers: [aiReviewMarker({
				id: "stale-marker",
				status: "needs_review",
				imageId: "old-image.webp",
				resultImageId: "result-image.webp",
			})],
			activityLog: [],
			reviewDecisions: [],
			versionReviewRequests: [],
		}));

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		await openWorkSection("เช็กคุณภาพ");
		const focusedQcIssue = screen.getByLabelText("รายการ QC ที่กำลังแก้");

		expect(within(focusedQcIssue).getByText(/ผล AI นี้ผูกกับรูปเก่า old-image.webp แต่หน้า 1 ตอนนี้ใช้ image-1.webp; รันพื้นที่นี้ใหม่ก่อนยืนยันหรือวางเลเยอร์/)).toBeTruthy();
		await fireEvent.click(within(focusedQcIssue).getByRole("button", { name: /เปิดรีวิวผล AI/ }));

		expect(projectStore.selectedAiReviewMarkerId).toBe("stale-marker");
		expect(projectStore.statusMsg).toBe("รูปต้นทางของผล AI ไม่ตรงกับหน้าปัจจุบัน; รันพื้นที่นี้ใหม่ก่อนยืนยันหรือวางเลเยอร์");
		await waitFor(() => expect(screen.getByRole("button", { name: "รีวิวผล AI เปิดอยู่" })).toBeTruthy());
		expect(screen.getAllByText("รูปต้นทางเปลี่ยนแล้ว").length).toBeGreaterThan(0);
	});

	it("routes stale AI marker link QC into AI Review", async () => {
		projectStore.__setProjectForTesting(project({
			comments: [],
			tasks: [],
			aiReviewMarkers: [aiReviewMarker({
				id: "stale-link-marker",
				status: "retry_requested",
				linkedCommentIds: ["deleted-comment"],
				linkedTaskIds: ["deleted-task"],
			})],
			activityLog: [],
			reviewDecisions: [],
			versionReviewRequests: [],
		}));

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		await openWorkSection("เช็กคุณภาพ");
		const focusedQcIssue = screen.getByLabelText("รายการ QC ที่กำลังแก้");

		expect(within(focusedQcIssue).getByText(/โน้ต deleted-comment ที่ผูกกับผล AI หาย/)).toBeTruthy();
		await fireEvent.click(within(focusedQcIssue).getByRole("button", { name: /เปิดรีวิวผล AI/ }));

		expect(projectStore.selectedAiReviewMarkerId).toBe("stale-link-marker");
		expect(projectStore.statusMsg).toBe("โน้ตที่ผูกกับผล AI หาย; ล้างลิงก์หรือเพิ่มโน้ตแก้ใหม่");
		await waitFor(() => expect(screen.getByRole("button", { name: "รีวิวผล AI เปิดอยู่" })).toBeTruthy());
		expect(screen.getAllByText("โน้ต/งานแก้ที่ผูกไว้หาย").length).toBeGreaterThan(0);
	});

	it("routes stale workflow task reference QC into Workflow", async () => {
		vi.spyOn(projectStore, "loadWorkflow").mockResolvedValue();
		projectStore.__setProjectForTesting(project({
			comments: [],
			tasks: [task({
				id: "stale-task",
				type: "typeset",
				status: "doing",
				priority: "high",
				layerId: "deleted-layer",
				title: "Typeset removed bubble",
			})],
			activityLog: [],
			reviewDecisions: [],
			versionReviewRequests: [],
		}));

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		await openWorkSection("เช็กคุณภาพ");
		const focusedQcIssue = screen.getByLabelText("รายการ QC ที่กำลังแก้");

		expect(within(focusedQcIssue).getByText(/หน้า 1 งาน "Typeset removed bubble" ชี้ไปเลเยอร์ deleted-layer ที่ไม่มีแล้ว/)).toBeTruthy();
		await fireEvent.click(within(focusedQcIssue).getByRole("button", { name: /เปิดงานผลิต/ }));

		expect(projectStore.selectedWorkflowTaskId).toBe("stale-task");
		expect(projectStore.statusMsg).toBe("เลเยอร์ของงานผลิตหาย; เลือกใหม่หรือปิดงานนี้");
		await waitFor(() => expect(screen.getByRole("button", { name: "ขั้นงานละเอียด เปิดอยู่" })).toBeTruthy());
	});

	it("routes stale review decision QC into Workflow without changing pages", async () => {
		projectStore.__setProjectForTesting(project({
			comments: [],
			tasks: [],
			aiReviewMarkers: [],
			reviewDecisions: [reviewDecision({
				id: "stale-review",
				pageIndex: 4,
				body: "This review belongs to an imported page that no longer exists",
			})],
			activityLog: [],
			versionReviewRequests: [],
		}));

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		await openWorkSection("เช็กคุณภาพ");
		const focusedQcIssue = screen.getByLabelText("รายการ QC ที่กำลังแก้");

		expect(within(focusedQcIssue).getByText(/ผลรีวิวชี้ไปหน้า 5 ที่ไม่มีแล้ว/)).toBeTruthy();
		await fireEvent.click(within(focusedQcIssue).getByRole("button", { name: /เปิดรีวิว/ }));

		expect(projectStore.project?.currentPage).toBe(0);
		expect(projectStore.selectedReviewDecisionId).toBe("stale-review");
		expect(projectStore.statusMsg).toBe("หน้ารีวิวหาย; สร้างใหม่บนหน้าที่ถูกต้องหรือลบรายการเก่า");
		await waitFor(() => expect(screen.getByRole("button", { name: "ขั้นงานละเอียด เปิดอยู่" })).toBeTruthy());
		expect(screen.getByText("รายการเก่า")).toBeTruthy();
		expect(screen.getByText("ตรวจหน้า 5 หาย")).toBeTruthy();
		expect(screen.getByText(/หน้า 5 หาย - lead/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "อนุมัติ" })).toBeNull();
		expect(screen.getAllByText("กำลังบันทึกผล").length).toBeGreaterThanOrEqual(1);
	});

	it("routes missing-page comment QC into Comments without changing pages", async () => {
		projectStore.__setProjectForTesting(project({
			comments: [comment({
				id: "comment-missing-page",
				pageIndex: 4,
				layerId: "deleted-layer",
				body: "This comment belongs to a deleted page",
			})],
			tasks: [],
			aiReviewMarkers: [],
			reviewDecisions: [],
			activityLog: [],
			versionReviewRequests: [],
		}));

		render(WorkModePanel, {
			props: {
				onOpenVersionReview: vi.fn(),
				onOpenProjectPages: vi.fn(),
			},
		});

		await openWorkSection("เช็กคุณภาพ");
		const focusedQcIssue = screen.getByLabelText("รายการ QC ที่กำลังแก้");

		expect(within(focusedQcIssue).getByText(/โน้ตที่เปิดอยู่ชี้ไป หน้า 5 ที่ไม่มีแล้ว/)).toBeTruthy();
		await fireEvent.click(within(focusedQcIssue).getByRole("button", { name: /เปิดโน้ต/ }));

		expect(projectStore.project?.currentPage).toBe(0);
		expect(projectStore.selectedProjectCommentId).toBe("comment-missing-page");
		expect(projectStore.statusMsg).toBe("หน้าโน้ตหาย; ปิดหรือสร้างใหม่บนหน้าที่ถูกต้อง");
		await waitFor(() => expect(screen.getByRole("button", { name: "โน้ต เปิดอยู่" })).toBeTruthy());
		expect(screen.getByText("หน้า 5 หาย")).toBeTruthy();
		expect(screen.getAllByText("This comment belongs to a deleted page").length).toBeGreaterThan(0);
	});

	it("scrolls newly opened lower work sections into view for narrow inspectors", async () => {
		const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
		const scrollIntoView = vi.fn();
		HTMLElement.prototype.scrollIntoView = scrollIntoView;
		projectStore.__setProjectForTesting(project());

		try {
			render(WorkModePanel, {
				props: {
					onOpenVersionReview: vi.fn(),
					onOpenProjectPages: vi.fn(),
				},
			});

			await openWorkSection("เช็กคุณภาพ");

			await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" }));
		} finally {
			HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
		}
	});
});
