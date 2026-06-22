import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
// Register the locale dictionaries (addMessages + init) so WorkCommentsPanel's $_(...) keys
// resolve to real strings instead of the raw key. test-setup.ts forces the active locale to th.
import "$lib/i18n";
import WorkCommentsPanel from "$lib/components/WorkCommentsPanel.svelte";
import WorkInboxPanel from "$lib/components/WorkInboxPanel.svelte";
import WorkQcPanel from "$lib/components/WorkQcPanel.svelte";
import WorkspaceHubPanel from "$lib/components/WorkspaceHubPanel.svelte";
import WorkWorkflowPanel from "$lib/components/WorkWorkflowPanel.svelte";
import type { QcIssue } from "$lib/project/qc-checks.js";
import type { WorkInboxItem } from "$lib/project/work-inbox.js";
import type { ActivityEvent, PageReviewDecision, ProjectComment, WorkflowTask, WorkspaceFeedItem } from "$lib/types.js";

function inboxItem(overrides: Partial<WorkInboxItem> = {}): WorkInboxItem {
	return {
		id: "inbox-1",
		kind: "comment",
		severity: "warning",
		pageIndex: 0,
		titleCode: "note",
		detail: { kind: "text", text: "Fix translated layer" },
		sourceId: "comment-1",
		...overrides,
	};
}

function feedItem(overrides: Partial<WorkspaceFeedItem> = {}): WorkspaceFeedItem {
	return {
		id: "feed-1",
		kind: "comment",
		sourceId: "comment-1",
		pageIndex: 0,
		title: "Review comment",
		detail: "Fix layer tone",
		createdAt: "2026-05-12T12:34:00.000Z",
		severity: "warning",
		mentions: ["lead"],
		...overrides,
	};
}

function projectComment(overrides: Partial<ProjectComment> = {}): ProjectComment {
	return {
		id: "comment-1",
		pageIndex: 0,
		layerId: "layer-1",
		body: "Please check this line",
		author: "lead",
		mentions: ["letterer"],
		status: "open",
		createdAt: "2026-05-12T12:34:00.000Z",
		updatedAt: "2026-05-12T12:34:00.000Z",
		...overrides,
	};
}

function workflowTask(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
	return {
		id: "task-1",
		type: "typeset",
		status: "doing",
		priority: "normal",
		pageIndex: 0,
		title: "Typeset page",
		assignee: "maya",
		createdAt: "2026-05-12T12:34:00.000Z",
		updatedAt: "2026-05-12T12:34:00.000Z",
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
		createdAt: "2026-05-12T12:34:00.000Z",
		updatedAt: "2026-05-12T12:34:00.000Z",
		...overrides,
	};
}

function activityEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
	return {
		id: "activity-1",
		type: "task_updated",
		message: "Task moved to review",
		actor: "lead",
		createdAt: "2026-05-12T12:34:00.000Z",
		...overrides,
	};
}

function qcIssue(overrides: Partial<QcIssue> = {}): QcIssue {
	return {
		id: "qc-1",
		code: "empty_text_layer",
		severity: "error",
		// Renders (th, byte-exact) to "หน้า 1 มี เลเยอร์ dialogue ว่าง" via
		// resolveQcIssueMessage — replaces the former pre-built Thai `message`.
		messageCode: "empty_text_layer",
		messageValues: { page: 1, layerLabelCode: "category", layerCategory: "dialogue" },
		pageIndex: 0,
		layerId: "layer-1",
		layerKind: "text",
		...overrides,
	};
}

describe("WorkCommentsPanel", () => {
	it("renders comments, mentions, anchor chips, and delegates row actions", async () => {
		const onFocusAnchor = vi.fn();
		const onUseCommentAsReviewNote = vi.fn();
		const onUseOpenCommentsAsReviewNote = vi.fn();
		const onResolveComment = vi.fn();
		const comment = projectComment();

		render(WorkCommentsPanel, {
			props: {
				projectOpen: true,
				loading: false,
				commentText: "Needs review",
				anchorMode: "layer",
				selectedLayerAvailable: true,
				selectedLayerLabel: "Translated line",
				regionAvailable: true,
				comments: [comment],
				selectedCommentId: comment.id,
				getAnchorLabel: () => "Layer: Translated line",
				onCommentTextChange: vi.fn(),
				onAnchorModeChange: vi.fn(),
				onAddComment: vi.fn(),
				onFocusAnchor,
				onUseCommentAsReviewNote,
				onUseOpenCommentsAsReviewNote,
				onResolveComment,
			},
		});

		expect(screen.getAllByText("Please check this line")).toHaveLength(2);
		expect(screen.getByText("@letterer")).toBeTruthy();
		expect(screen.getByRole("region", { name: "รายละเอียดโน้ตที่กำลังดู" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "เปิดตำแหน่งโน้ตที่เลือก" })).toBeTruthy();
		expect(screen.getByText("ชุดตรวจ")).toBeTruthy();
		expect(screen.getByText("1 โน้ตเปิดอยู่")).toBeTruthy();
		expect(screen.getByText("1 เลเยอร์ / 1 เมนชัน")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "เลเยอร์: Translated line" }));
		await fireEvent.click(screen.getByRole("button", { name: "ใช้โน้ตที่เลือกจาก lead เป็นโน้ตรีวิว" }));
		await fireEvent.click(screen.getByRole("button", { name: "ใช้โน้ตจาก lead เป็นโน้ตรีวิว" }));
		await fireEvent.click(screen.getByRole("button", { name: "ใช้โน้ตเปิดอยู่ทั้งหมด 1 รายการเป็นโน้ตรีวิว" }));
		await fireEvent.click(screen.getByRole("button", { name: "ปิดโน้ตที่เลือก" }));

		expect(onFocusAnchor).toHaveBeenCalledWith(comment);
		expect(onUseCommentAsReviewNote).toHaveBeenCalledTimes(2);
		expect(onUseCommentAsReviewNote).toHaveBeenCalledWith(comment);
		expect(onUseOpenCommentsAsReviewNote).toHaveBeenCalledWith([comment]);
		expect(onResolveComment).toHaveBeenCalledWith(comment.id);
	});

	it("keeps resolved comment anchors inspectable without offering review-note actions", async () => {
		const onFocusAnchor = vi.fn();
		const comment = projectComment({
			id: "comment-resolved",
			status: "resolved",
			body: "Resolved anchor note",
		});

		render(WorkCommentsPanel, {
			props: {
				projectOpen: true,
				loading: false,
				commentText: "",
				anchorMode: "page",
				selectedLayerAvailable: false,
				selectedLayerLabel: "",
				regionAvailable: false,
				comments: [comment],
				selectedCommentId: null,
				getAnchorLabel: () => "Layer: Old line",
				onCommentTextChange: vi.fn(),
				onAnchorModeChange: vi.fn(),
				onAddComment: vi.fn(),
				onFocusAnchor,
				onUseCommentAsReviewNote: vi.fn(),
				onResolveComment: vi.fn(),
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: /เสร็จ 1/ }));
		await fireEvent.click(screen.getByRole("button", { name: "เลเยอร์: Old line" }));

		expect(onFocusAnchor).toHaveBeenCalledWith(comment);
		expect(screen.queryByRole("button", { name: "ใช้โน้ตจาก lead เป็นโน้ตรีวิว" })).toBeNull();
		expect(screen.queryByRole("button", { name: "โน้ตปิดแล้ว" })).toBeNull();
		expect(screen.getAllByText("ปิดแล้ว").length).toBeGreaterThan(0);
	});

	it("delegates comment text, anchor mode, and add actions", async () => {
		const onCommentTextChange = vi.fn();
		const onAnchorModeChange = vi.fn();
		const onAddComment = vi.fn();

		render(WorkCommentsPanel, {
			props: {
				projectOpen: true,
				loading: false,
				commentText: "Ready",
				anchorMode: "page",
				selectedLayerAvailable: false,
				selectedLayerLabel: "",
				regionAvailable: false,
				comments: [],
				selectedCommentId: null,
				getAnchorLabel: () => null,
				onCommentTextChange,
				onAnchorModeChange,
				onAddComment,
				onFocusAnchor: vi.fn(),
				onResolveComment: vi.fn(),
			},
		});

		await fireEvent.input(screen.getByLabelText("โน้ตใหม่ของหน้านี้"), {
			target: { value: "Needs redraw" },
		});
		await fireEvent.click(screen.getByRole("radio", { name: "พื้นที่รูป" }));
		await fireEvent.click(screen.getByRole("button", { name: "เพิ่มโน้ต" }));

		expect(onCommentTextChange).toHaveBeenCalledWith("Needs redraw");
		expect(onAnchorModeChange).toHaveBeenCalledWith("region");
		expect(onAddComment).toHaveBeenCalledTimes(1);
	});

	it("keeps open comments first and exposes review filters", async () => {
		const openComment = projectComment({
			id: "comment-open",
			body: "Open redraw issue",
			status: "open",
			createdAt: "2026-05-12T10:00:00.000Z",
			updatedAt: "2026-05-12T10:00:00.000Z",
		});
		const resolvedComment = projectComment({
			id: "comment-resolved",
			body: "Already fixed line",
			status: "resolved",
			createdAt: "2026-05-12T12:00:00.000Z",
			updatedAt: "2026-05-12T12:00:00.000Z",
		});

		const { container } = render(WorkCommentsPanel, {
			props: {
				projectOpen: true,
				loading: false,
				commentText: "",
				anchorMode: "page",
				selectedLayerAvailable: false,
				selectedLayerLabel: "",
				regionAvailable: false,
				comments: [resolvedComment, openComment],
				selectedCommentId: null,
				getAnchorLabel: () => null,
				onCommentTextChange: vi.fn(),
				onAnchorModeChange: vi.fn(),
				onAddComment: vi.fn(),
				onFocusAnchor: vi.fn(),
				onResolveComment: vi.fn(),
			},
		});

		expect(screen.getAllByText("Open redraw issue").length).toBeGreaterThan(0);
		expect(screen.queryByText("Already fixed line")).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: /ทั้งหมด 2/ }));
		const allBodies = [...container.querySelectorAll(".comment-body")].map((node) => node.textContent);
		expect(allBodies).toEqual(["Open redraw issue", "Already fixed line"]);

		await fireEvent.click(screen.getByRole("button", { name: /เสร็จ 1/ }));
		expect(screen.queryByText("Open redraw issue")).toBeNull();
		expect(screen.getAllByText("Already fixed line").length).toBeGreaterThan(0);
	});

	it("navigates comments inside the active filter", async () => {
		const onFocusAnchor = vi.fn();
		const selectedComment = projectComment({
			id: "comment-selected",
			body: "Selected open issue",
			status: "open",
			createdAt: "2026-05-12T10:00:00.000Z",
			updatedAt: "2026-05-12T10:00:00.000Z",
		});
		const nextOpenComment = projectComment({
			id: "comment-next",
			body: "Next open issue",
			status: "open",
			createdAt: "2026-05-12T12:00:00.000Z",
			updatedAt: "2026-05-12T12:00:00.000Z",
		});
		const resolvedComment = projectComment({
			id: "comment-resolved",
			body: "Resolved issue",
			status: "resolved",
			createdAt: "2026-05-12T13:00:00.000Z",
			updatedAt: "2026-05-12T13:00:00.000Z",
		});

		render(WorkCommentsPanel, {
			props: {
				projectOpen: true,
				loading: false,
				commentText: "",
				anchorMode: "page",
				selectedLayerAvailable: false,
				selectedLayerLabel: "",
				regionAvailable: false,
				comments: [resolvedComment, nextOpenComment, selectedComment],
				selectedCommentId: selectedComment.id,
				getAnchorLabel: () => "ทั้งหน้า",
				onCommentTextChange: vi.fn(),
				onAnchorModeChange: vi.fn(),
				onAddComment: vi.fn(),
				onFocusAnchor,
				onResolveComment: vi.fn(),
			},
		});

		expect(screen.getByText("1/2")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "โน้ตถัดไป" }));
		expect(onFocusAnchor).toHaveBeenLastCalledWith(nextOpenComment);

		await fireEvent.click(screen.getByRole("button", { name: /เสร็จ 1/ }));
		expect(screen.getByText("1/1")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "โน้ตถัดไป" }));
		expect(onFocusAnchor).toHaveBeenLastCalledWith(resolvedComment);
	});

	it("focuses the first visible comment before a comment is selected", async () => {
		const onFocusAnchor = vi.fn();
		const onUseCommentAsReviewNote = vi.fn();
		const onResolveComment = vi.fn();
		const comment = projectComment({ id: "comment-visible", body: "Visible review note" });

		render(WorkCommentsPanel, {
			props: {
				projectOpen: true,
				loading: false,
				commentText: "",
				anchorMode: "page",
				selectedLayerAvailable: false,
				selectedLayerLabel: "",
				regionAvailable: false,
				comments: [comment],
				selectedCommentId: null,
				getAnchorLabel: () => "ทั้งหน้า",
				onCommentTextChange: vi.fn(),
				onAnchorModeChange: vi.fn(),
				onAddComment: vi.fn(),
				onFocusAnchor,
				onUseCommentAsReviewNote,
				onResolveComment,
			},
		});

		expect(screen.getByText("1/1")).toBeTruthy();
		expect(screen.getByRole("region", { name: "รายละเอียดโน้ตที่กำลังดู" })).toBeTruthy();
		expect(screen.getAllByText("Visible review note")).toHaveLength(2);

		await fireEvent.click(screen.getByRole("button", { name: "เปิดตำแหน่งโน้ตที่เลือก" }));
		await fireEvent.click(screen.getByRole("button", { name: "ใช้โน้ตจาก lead เป็นโน้ตรีวิว" }));
		await fireEvent.click(screen.getByRole("button", { name: "ปิดโน้ตที่เลือก" }));

		expect(onFocusAnchor).toHaveBeenCalledWith(comment);
		expect(onUseCommentAsReviewNote).toHaveBeenCalledWith(comment);
		expect(onResolveComment).toHaveBeenCalledWith(comment.id);
	});

	it("lets reviewers expand and compact long comment lists", async () => {
		const comments = Array.from({ length: 14 }, (_, index) => projectComment({
			id: `comment-${index}`,
			body: `Comment ${index}`,
			createdAt: `2026-05-12T12:${String(index).padStart(2, "0")}:00.000Z`,
			updatedAt: `2026-05-12T12:${String(index).padStart(2, "0")}:00.000Z`,
		}));

		render(WorkCommentsPanel, {
			props: {
				projectOpen: true,
				loading: false,
				commentText: "",
				anchorMode: "page",
				selectedLayerAvailable: false,
				selectedLayerLabel: "",
				regionAvailable: false,
				comments,
				selectedCommentId: null,
				getAnchorLabel: () => null,
				onCommentTextChange: vi.fn(),
				onAnchorModeChange: vi.fn(),
				onAddComment: vi.fn(),
				onFocusAnchor: vi.fn(),
				onResolveComment: vi.fn(),
			},
		});

		expect(screen.getAllByText("Comment 13").length).toBeGreaterThan(0);
		expect(screen.queryByText("Comment 0")).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "แสดงโน้ตทั้งหมด 14 รายการ" }));
		expect(screen.getByText("Comment 0")).toBeTruthy();
		expect(screen.getByRole("button", { name: "ย่อรายการโน้ต" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "ย่อรายการโน้ต" }));
		expect(screen.queryByText("Comment 0")).toBeNull();
	});

	it("uses a passive receipt when the selected anchor cannot be created", () => {
		render(WorkCommentsPanel, {
			props: {
				projectOpen: true,
				loading: false,
				commentText: "Ready",
				anchorMode: "layer",
				selectedLayerAvailable: false,
				selectedLayerLabel: "",
				regionAvailable: false,
				comments: [],
				selectedCommentId: null,
				getAnchorLabel: () => null,
				onCommentTextChange: vi.fn(),
				onAnchorModeChange: vi.fn(),
				onAddComment: vi.fn(),
				onFocusAnchor: vi.fn(),
				onResolveComment: vi.fn(),
			},
		});

		expect(screen.queryByRole("button", { name: "เพิ่มโน้ต" })).toBeNull();
		expect(screen.getAllByText("เลือกตำแหน่งที่ใช้ได้ก่อน").length).toBeGreaterThan(0);
	});
});

describe("WorkWorkflowPanel", () => {
	const statusOptions = [
		{ id: "todo", label: "รอทำ" },
		{ id: "doing", label: "กำลังทำ" },
		{ id: "review", label: "Review" },
		{ id: "done", label: "เสร็จ" },
	] as const;
	const priorityOptions = [
		{ id: "normal", label: "Normal" },
		{ id: "high", label: "High" },
		{ id: "urgent", label: "Urgent" },
	] as const;

	it("renders review, task, activity, and delegates workflow actions", async () => {
		const onSync = vi.fn();
		const onReviewNoteChange = vi.fn();
		const onSubmitReviewDecision = vi.fn();
		const onTaskStatusChange = vi.fn();
		const onTaskPriorityChange = vi.fn();
		const onTaskAssigneeChange = vi.fn();
		const onTaskDueAtChange = vi.fn();
		const task = workflowTask({ priority: "high", dueAt: "2026-05-13T02:30:00.000Z" });

		render(WorkWorkflowPanel, {
			props: {
				projectOpen: true,
				workflowLoading: false,
				reviewLoading: false,
				workflowDoneCount: 1,
				totalTaskCount: 2,
				reviewNote: "Looks good",
				focusedReviewDecision: reviewDecision(),
				selectedReviewDecisionId: "review-1",
				reviewScopeLabel: "หน้า 2",
				reviewScopeKind: "page",
				tasks: [task],
				selectedTaskId: task.id,
				statusOptions,
				priorityOptions,
				activityLog: [activityEvent()],
				timeLabel: () => "12:34",
				onSync,
				onReviewNoteChange,
				onSubmitReviewDecision,
				onTaskStatusChange,
				onTaskPriorityChange,
				onTaskAssigneeChange,
				onTaskDueAtChange,
				soloMode: false,
			},
		});

		expect(screen.getByText("1/2 เสร็จ")).toBeTruthy();
		expect(screen.getByText("ตรวจหน้า 2")).toBeTruthy();
		expect(screen.queryByText("ตรวจหน้านี้")).toBeNull();
		expect(screen.getByText("Needs fixes")).toBeTruthy();
		const focusCard = screen.getByRole("region", { name: "งานผลิตที่กำลังโฟกัส" });
		expect(within(focusCard).getByText("Typeset / 1/1")).toBeTruthy();
		expect(within(focusCard).getByText("Typeset page")).toBeTruthy();
		expect(within(focusCard).getByText(/กำลังทำ \/ สำคัญ \/ @maya/)).toBeTruthy();
		expect(screen.getAllByText("Typeset page").length).toBeGreaterThan(1);
		expect(screen.getAllByText("สำคัญ").length).toBeGreaterThan(0);
		expect(screen.getAllByText(/ครบกำหนด/).length).toBeGreaterThan(1);
		expect(screen.getByText("Task moved to review")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "ซิงก์งานผลิต" }));
		await fireEvent.click(within(focusCard).getByRole("button", { name: /ส่งงานเข้ารีวิว: Typeset page/ }));
		await fireEvent.input(screen.getByLabelText("โน้ตรีวิวของหน้านี้"), {
			target: { value: "Ship it" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "อนุมัติ" }));
		await fireEvent.change(screen.getByLabelText("สถานะงาน Typeset page"), {
			target: { value: "done" },
		});
		await fireEvent.change(screen.getByLabelText("ความด่วนของงาน Typeset page"), {
			target: { value: "urgent" },
		});
		await fireEvent.change(screen.getByLabelText("ผู้รับผิดชอบงาน Typeset page"), {
			target: { value: "nina" },
		});
		const dueValue = "2026-05-14T09:15";
		await fireEvent.change(screen.getByLabelText("กำหนดส่งงาน Typeset page"), {
			target: { value: dueValue },
		});

		expect(onSync).toHaveBeenCalledTimes(1);
		expect(onReviewNoteChange).toHaveBeenCalledWith("Ship it");
		expect(onSubmitReviewDecision).toHaveBeenCalledWith("approved");
		expect(onTaskStatusChange).toHaveBeenCalledWith(task.id, "review");
		expect(onTaskStatusChange).toHaveBeenCalledWith(task.id, "done");
		expect(onTaskPriorityChange).toHaveBeenCalledWith(task.id, "urgent");
		expect(onTaskAssigneeChange).toHaveBeenCalledWith(task.id, "nina");
		expect(onTaskDueAtChange).toHaveBeenCalledWith(task.id, new Date(dueValue).toISOString());
	});

	it("keeps the review decision title tied to the current review scope", async () => {
		const baseProps = {
			projectOpen: true,
			workflowLoading: false,
			reviewLoading: false,
			workflowDoneCount: 0,
			totalTaskCount: 0,
			reviewNote: "",
			focusedReviewDecision: reviewDecision({ pageIndex: 4 }),
			selectedReviewDecisionId: null,
			tasks: [],
			selectedTaskId: null,
			statusOptions,
			priorityOptions,
			activityLog: [],
			timeLabel: (value: string) => value,
			onSync: vi.fn(),
			onReviewNoteChange: vi.fn(),
			onSubmitReviewDecision: vi.fn(),
			onTaskStatusChange: vi.fn(),
			onTaskPriorityChange: vi.fn(),
			onTaskAssigneeChange: vi.fn(),
			onTaskDueAtChange: vi.fn(),
		};

		const { rerender } = render(WorkWorkflowPanel, {
			props: {
				...baseProps,
				reviewScopeLabel: "หน้า 5 หาย",
				reviewScopeKind: "page" as const,
			},
		});

		expect(screen.getByText("ตรวจหน้า 5 หาย")).toBeTruthy();
		expect(screen.queryByText("ตรวจหน้านี้")).toBeNull();

		await rerender({
			...baseProps,
			reviewScopeLabel: "ทั้งตอน",
			reviewScopeKind: "chapter" as const,
		});

		expect(screen.getByText("ตรวจทั้งตอน")).toBeTruthy();
	});

	it("requires a reviewer note before requesting changes", async () => {
		const baseProps = {
			projectOpen: true,
			workflowLoading: false,
			reviewLoading: false,
			workflowDoneCount: 0,
			totalTaskCount: 0,
			focusedReviewDecision: null,
			selectedReviewDecisionId: null,
			tasks: [],
			selectedTaskId: null,
			statusOptions,
			priorityOptions,
			activityLog: [],
			timeLabel: (value: string) => value,
			onSync: vi.fn(),
			onReviewNoteChange: vi.fn(),
			onSubmitReviewDecision: vi.fn(),
			onTaskStatusChange: vi.fn(),
			onTaskPriorityChange: vi.fn(),
			onTaskAssigneeChange: vi.fn(),
			onTaskDueAtChange: vi.fn(),
		};

		const { rerender } = render(WorkWorkflowPanel, {
			props: {
				...baseProps,
				reviewNote: "",
			},
		});

		expect(screen.queryByRole("button", { name: "ส่งกลับแก้" })).toBeNull();
		expect(screen.getByText("ใส่โน้ตก่อนส่งกลับแก้")).toBeTruthy();

		await rerender({
			...baseProps,
			reviewNote: "Fix the redraw edge before approval",
		});

		expect(screen.getByRole("button", { name: "ส่งกลับแก้" })).toBeTruthy();
		expect(screen.getByText("ส่งกลับให้แก้")).toBeTruthy();
	});

	it("renders workflow loading states as passive receipts instead of disabled controls", () => {
		const task = workflowTask({ status: "review", priority: "urgent", dueAt: "2026-05-13T02:30:00.000Z" });

		render(WorkWorkflowPanel, {
			props: {
				projectOpen: true,
				workflowLoading: true,
				reviewLoading: true,
				workflowDoneCount: 0,
				totalTaskCount: 1,
				reviewNote: "Need final check",
				focusedReviewDecision: null,
				selectedReviewDecisionId: null,
				tasks: [task],
				selectedTaskId: task.id,
				statusOptions,
				priorityOptions,
				activityLog: [],
				timeLabel: (value) => value,
				onSync: vi.fn(),
				onReviewNoteChange: vi.fn(),
				onSubmitReviewDecision: vi.fn(),
				onTaskStatusChange: vi.fn(),
				onTaskPriorityChange: vi.fn(),
				onTaskAssigneeChange: vi.fn(),
				onTaskDueAtChange: vi.fn(),
			},
		});

		expect(screen.queryByRole("button", { name: "ซิงก์งานผลิต" })).toBeNull();
		expect(screen.getByLabelText("สถานะซิงก์งานผลิต").textContent).toContain("กำลังซิงก์งาน");
		expect(screen.queryByRole("button", { name: "อนุมัติ" })).toBeNull();
		expect(screen.queryByRole("button", { name: "ส่งกลับแก้" })).toBeNull();
		expect(screen.getAllByText("กำลังรีวิว").length).toBeGreaterThan(0);
		expect(screen.getByLabelText("สถานะงาน Typeset page").textContent).toContain("รอรีวิว");
		expect(screen.getByLabelText("ความด่วนของงาน Typeset page").textContent).toContain("ด่วน");
		expect(screen.queryAllByRole("button").some((button) => (button as HTMLButtonElement).disabled)).toBe(false);
		expect(screen.queryByRole("combobox", { name: "สถานะงาน Typeset page" })).toBeNull();
	});

	it("surfaces open comments as review-note prompts", async () => {
		const onUseCommentAsReviewNote = vi.fn();
		const openComment = projectComment({
			id: "comment-open",
			body: "Redraw cleanup still clips the tail bubble edge before QC approval.",
			status: "open",
			author: "maya",
			createdAt: "2026-05-14T01:00:00.000Z",
			updatedAt: "2026-05-14T01:00:00.000Z",
		});
		const resolvedComment = projectComment({
			id: "comment-resolved",
			body: "Old fixed note",
			status: "resolved",
			createdAt: "2026-05-14T02:00:00.000Z",
			updatedAt: "2026-05-14T02:00:00.000Z",
		});

		render(WorkWorkflowPanel, {
			props: {
				projectOpen: true,
				workflowLoading: false,
				reviewLoading: false,
				workflowDoneCount: 0,
				totalTaskCount: 0,
				reviewNote: "",
				focusedReviewDecision: null,
				selectedReviewDecisionId: null,
				tasks: [],
				selectedTaskId: null,
				openComments: [resolvedComment, openComment],
				selectedCommentId: openComment.id,
				statusOptions,
				priorityOptions,
				activityLog: [],
				timeLabel: (value) => value,
				getCommentAnchorLabel: () => "Layer: Bubble tail",
				onUseCommentAsReviewNote,
				onSync: vi.fn(),
				onReviewNoteChange: vi.fn(),
				onSubmitReviewDecision: vi.fn(),
				onTaskStatusChange: vi.fn(),
				onTaskPriorityChange: vi.fn(),
				onTaskAssigneeChange: vi.fn(),
				onTaskDueAtChange: vi.fn(),
			},
		});

		expect(screen.getByText("1 โน้ตเปิดอยู่")).toBeTruthy();
		expect(screen.getByText("Redraw cleanup still clips the tail bubble edge before QC approval.")).toBeTruthy();
		expect(screen.queryByText("Old fixed note")).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "ใช้โน้ตจาก maya เป็นโน้ตรีวิว" }));

		expect(onUseCommentAsReviewNote).toHaveBeenCalledWith(openComment);
	});

	it("can collect all open comments into one review note", async () => {
		const onReviewNoteChange = vi.fn();
		const newestComment = projectComment({
			id: "comment-newest",
			body: "Clean the redraw edge before final QC.",
			status: "open",
			author: "maya",
			createdAt: "2026-05-14T03:00:00.000Z",
			updatedAt: "2026-05-14T03:00:00.000Z",
		});
		const olderComment = projectComment({
			id: "comment-older",
			body: "Typeset the small scream bubble tighter.",
			status: "open",
			author: "nina",
			createdAt: "2026-05-14T01:00:00.000Z",
			updatedAt: "2026-05-14T01:00:00.000Z",
		});
		const resolvedComment = projectComment({
			id: "comment-resolved",
			body: "Resolved note should not be included",
			status: "resolved",
			createdAt: "2026-05-14T04:00:00.000Z",
			updatedAt: "2026-05-14T04:00:00.000Z",
		});

		render(WorkWorkflowPanel, {
			props: {
				projectOpen: true,
				workflowLoading: false,
				reviewLoading: false,
				workflowDoneCount: 0,
				totalTaskCount: 0,
				reviewNote: "",
				focusedReviewDecision: null,
				selectedReviewDecisionId: null,
				tasks: [],
				selectedTaskId: null,
				openComments: [olderComment, resolvedComment, newestComment],
				selectedCommentId: null,
				statusOptions,
				priorityOptions,
				activityLog: [],
				timeLabel: (value) => value,
				getCommentAnchorLabel: (comment) => comment.id === "comment-newest" ? "พื้นที่รูป: redraw edge" : "เลเยอร์: scream bubble",
				onUseCommentAsReviewNote: vi.fn(),
				onSync: vi.fn(),
				onReviewNoteChange,
				onSubmitReviewDecision: vi.fn(),
				onTaskStatusChange: vi.fn(),
				onTaskPriorityChange: vi.fn(),
				onTaskAssigneeChange: vi.fn(),
				onTaskDueAtChange: vi.fn(),
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "ใช้โน้ตเปิดอยู่ทั้งหมด 2 รายการเป็นโน้ตรีวิว" }));

		expect(onReviewNoteChange).toHaveBeenCalledWith(
			"1. Clean the redraw edge before final QC.\n   ตำแหน่ง: พื้นที่รูป: redraw edge\n\n"
				+ "2. Typeset the small scream bubble tighter.\n   ตำแหน่ง: เลเยอร์: scream bubble"
		);
	});

	it("renders workflow empty states", () => {
		const baseProps = {
			workflowLoading: false,
			reviewLoading: false,
			workflowDoneCount: 0,
			totalTaskCount: 0,
			reviewNote: "",
			focusedReviewDecision: null,
			selectedReviewDecisionId: null,
			tasks: [],
			selectedTaskId: null,
			statusOptions,
			priorityOptions,
			activityLog: [],
			timeLabel: (value: string) => value,
			onSync: vi.fn(),
			onReviewNoteChange: vi.fn(),
			onSubmitReviewDecision: vi.fn(),
			onTaskStatusChange: vi.fn(),
			onTaskPriorityChange: vi.fn(),
			onTaskAssigneeChange: vi.fn(),
			onTaskDueAtChange: vi.fn(),
		};

		const { unmount } = render(WorkWorkflowPanel, {
			props: {
				...baseProps,
				projectOpen: false,
			},
		});
		expect(screen.getByText("เปิดงานเพื่อจัดการงานผลิต")).toBeTruthy();
		unmount();

		render(WorkWorkflowPanel, {
			props: {
				...baseProps,
				projectOpen: true,
			},
		});
		expect(screen.getByText("เพิ่มงานเมื่อหน้านี้ต้องส่งต่อหรือรอคนอื่น")).toBeTruthy();
	});
});

describe("WorkInboxPanel", () => {
	it("renders current-page handoffs and delegates row open", async () => {
		const onOpenItem = vi.fn();
		const item = inboxItem();

		render(WorkInboxPanel, {
			props: {
				totalCount: 4,
				pageCount: 1,
				projectOpen: true,
				items: [item],
				scope: "page",
				selectedItemId: item.id,
				severityLabel: (severity) => severity.toUpperCase(),
				onScopeChange: vi.fn(),
				onOpenItem,
			},
		});

			expect(screen.getByText("4 งานเปิดอยู่")).toBeTruthy();
			expect(screen.getByText("1 บนหน้านี้")).toBeTruthy();
			expect(screen.getByText("WARNING")).toBeTruthy();
			// Localized title composed from the structured fields (comment → note).
			expect(screen.getByText("หน้า 1 - โน้ตรอแก้")).toBeTruthy();

			await fireEvent.click(screen.getByRole("button", { name: /เปิดงานด่วน/ }));

		expect(onOpenItem).toHaveBeenCalledWith(item);
	});

	it("renders workflow task ownership metadata in inbox rows", () => {
		const item = inboxItem({
			id: "workflow-task-1",
			kind: "workflow_task",
			severity: "warning",
			priority: "high",
			status: "doing",
			assignee: "maya",
			titleCode: "workflow",
			workflowTitle: { code: "typeset" },
			detail: { kind: "workflow_task", statusCode: "doing", assignee: "maya" },
			sourceId: "task-1",
		});

		render(WorkInboxPanel, {
			props: {
				totalCount: 1,
				pageCount: 1,
				projectOpen: true,
				items: [item],
				scope: "page",
				selectedItemId: null,
				severityLabel: (severity) => severity.toUpperCase(),
				onScopeChange: vi.fn(),
				onOpenItem: vi.fn(),
			},
		});

		expect(screen.getByText("สำคัญ")).toBeTruthy();
		expect(screen.getByText("กำลังทำ")).toBeTruthy();
		expect(screen.getByText("@maya")).toBeTruthy();
	});

	it("shows empty states for closed and clear workspaces", () => {
		const baseProps = {
			totalCount: 0,
			pageCount: 0,
			items: [],
			scope: "page" as const,
			selectedItemId: null,
			severityLabel: (severity: WorkInboxItem["severity"]) => severity,
			onScopeChange: vi.fn(),
			onOpenItem: vi.fn(),
		};

		const { unmount } = render(WorkInboxPanel, {
			props: {
				...baseProps,
				projectOpen: false,
			},
		});
		expect(screen.getByText("เปิดงานเพื่อดูงานด่วนและงานทีม")).toBeTruthy();
		unmount();

		render(WorkInboxPanel, {
			props: {
				...baseProps,
				projectOpen: true,
			},
		});
		expect(screen.getByText("ยังไม่มีงานเปิดอยู่บนหน้านี้")).toBeTruthy();
	});

	it("delegates inbox scope changes and changes all-project empty copy", async () => {
		const onScopeChange = vi.fn();

		render(WorkInboxPanel, {
			props: {
				totalCount: 0,
				pageCount: 0,
				projectOpen: true,
				items: [],
				scope: "all",
				selectedItemId: null,
				severityLabel: (severity) => severity,
				onScopeChange,
				onOpenItem: vi.fn(),
			},
		});

		expect(screen.getByText("ยังไม่มีงานเปิดอยู่ในงานนี้")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "หน้า" }));

		expect(onScopeChange).toHaveBeenCalledWith("page");
	});
});

describe("WorkspaceHubPanel", () => {
	it("renders feed rows, mentions, and delegates actionable row open", async () => {
		const onOpenItem = vi.fn();
		const item = feedItem({
			kind: "task",
			title: "Typeset page",
			detail: "normal / กำลังทำ / due soon 2026-05-13",
			dueAt: "2026-05-13T09:00:00.000Z",
			dueState: "soon",
		});

		render(WorkspaceHubPanel, {
			props: {
				projectOpen: true,
				totalEventCount: 8,
				pageEventCount: 2,
				loading: false,
				note: "",
				items: [item],
				scope: "page",
				filter: "all",
				selectedItemId: item.id,
				kindLabel: (kind) => kind.toUpperCase(),
				timeLabel: () => "12:34",
				isActionable: () => true,
				onNoteChange: vi.fn(),
				onScopeChange: vi.fn(),
				onFilterChange: vi.fn(),
				onSync: vi.fn(),
				onAddHandoff: vi.fn(),
				onOpenItem,
				soloMode: false,
			},
		});

		expect(screen.getByText("8 อัปเดตทั้งงาน")).toBeTruthy();
		expect(screen.getByText("2 อัปเดตหน้านี้")).toBeTruthy();
		expect(screen.getByText("TASK")).toBeTruthy();
		expect(screen.getAllByText("ใกล้ครบกำหนด 2026-05-13").length).toBeGreaterThan(0);
		expect(screen.getByText("เปิดงาน")).toBeTruthy();
		expect(screen.getByText("หน้า 1")).toBeTruthy();
		expect(screen.getByText("lead")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: /ไทป์เซ็ต หน้า 1/ }));

		expect(onOpenItem).toHaveBeenCalledWith(item);
	});

	it("visually separates passive workspace logs from actionable targets", async () => {
		const onOpenItem = vi.fn();
		const activity = feedItem({
			id: "activity:save",
			kind: "activity",
			sourceId: "event-1",
			pageIndex: undefined,
			title: "Version saved",
			detail: "Autosaved after text edits",
			severity: undefined,
			mentions: undefined,
		});

		const { container } = render(WorkspaceHubPanel, {
			props: {
				projectOpen: true,
				totalEventCount: 1,
				pageEventCount: 1,
				loading: false,
				note: "",
				items: [activity],
				scope: "page",
				filter: "all",
				selectedItemId: null,
				kindLabel: (kind) => kind.toUpperCase(),
				timeLabel: () => "12:34",
				isActionable: () => false,
				onNoteChange: vi.fn(),
				onScopeChange: vi.fn(),
				onFilterChange: vi.fn(),
				onSync: vi.fn(),
				onAddHandoff: vi.fn(),
				onOpenItem,
				soloMode: false,
			},
		});

		expect(screen.getByText("อ่านบันทึก")).toBeTruthy();
		expect(screen.getByText("อ่านอย่างเดียว")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Version saved/ })).toBeNull();
		expect(container.querySelector(".workspace-feed-focus.passive")).toBeTruthy();

		await fireEvent.click(screen.getByText("อ่านอย่างเดียว"));
		expect(onOpenItem).not.toHaveBeenCalled();
	});

	it("delegates note updates and handoff actions", async () => {
		const onNoteChange = vi.fn();
		const onAddHandoff = vi.fn();

		render(WorkspaceHubPanel, {
			props: {
				projectOpen: true,
				totalEventCount: 0,
				pageEventCount: 0,
				loading: false,
				note: "Ready for review",
				items: [],
				scope: "page",
				filter: "all",
				selectedItemId: null,
				kindLabel: (kind) => kind,
				timeLabel: (value) => value,
				isActionable: () => false,
				onNoteChange,
				onScopeChange: vi.fn(),
				onFilterChange: vi.fn(),
				onSync: vi.fn(),
				onAddHandoff,
				onOpenItem: vi.fn(),
				soloMode: false,
			},
		});

		await fireEvent.input(screen.getByLabelText("โน้ตส่งต่อทีม"), {
			target: { value: "Needs lettering pass" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "เพิ่มส่งต่อทีม" }));

		expect(onNoteChange).toHaveBeenCalledWith("Needs lettering pass");
		expect(onAddHandoff).toHaveBeenCalledTimes(1);
	});

	it("delegates workspace scope changes and changes all-project empty copy", async () => {
		const onScopeChange = vi.fn();

		render(WorkspaceHubPanel, {
			props: {
				projectOpen: true,
				totalEventCount: 0,
				pageEventCount: 0,
				loading: false,
				note: "",
				items: [],
				scope: "all",
				filter: "all",
				selectedItemId: null,
				kindLabel: (kind) => kind,
				timeLabel: (value) => value,
				isActionable: () => false,
				onNoteChange: vi.fn(),
				onScopeChange,
				onFilterChange: vi.fn(),
				onSync: vi.fn(),
				onAddHandoff: vi.fn(),
				onOpenItem: vi.fn(),
				soloMode: false,
			},
		});

		expect(screen.getByText("ยังไม่มีอัปเดตทีมของงานนี้")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "หน้า" }));

		expect(onScopeChange).toHaveBeenCalledWith("page");
	});

	it("filters workspace rows by attention, due, tasks, exports, and notes", async () => {
		const onFilterChange = vi.fn();
		const dueTask = feedItem({
			id: "task:due",
			kind: "task",
			title: "Due task",
			detail: "normal / todo / due soon 2026-05-13",
			dueAt: "2026-05-13T09:00:00.000Z",
			dueState: "soon",
			severity: "warning",
		});
		const note = feedItem({
			id: "message:note",
			kind: "message",
			title: "Handoff note",
			detail: "Ready for lettering",
			severity: undefined,
			dueAt: undefined,
			dueState: undefined,
		});
		const activity = feedItem({
			id: "activity:save",
			kind: "activity",
			title: "Version saved",
			detail: "save",
			severity: undefined,
			dueAt: undefined,
			dueState: undefined,
		});
		const exportRun = feedItem({
			id: "export:failed",
			kind: "export_run",
			title: "Export failed",
			detail: "2 pages / blocked by hold",
			severity: "error",
			dueAt: undefined,
			dueState: undefined,
		});

		render(WorkspaceHubPanel, {
			props: {
				projectOpen: true,
				totalEventCount: 4,
				pageEventCount: 4,
				loading: false,
				note: "",
				items: [dueTask, note, activity, exportRun],
				scope: "page",
				filter: "due",
				selectedItemId: null,
				kindLabel: (kind) => kind.toUpperCase(),
				timeLabel: () => "12:34",
				isActionable: () => true,
				onNoteChange: vi.fn(),
				onScopeChange: vi.fn(),
				onFilterChange,
				onSync: vi.fn(),
				onAddHandoff: vi.fn(),
				onOpenItem: vi.fn(),
				soloMode: false,
			},
		});

		expect(screen.getByText("Due task")).toBeTruthy();
		expect(screen.queryByText("Handoff note")).toBeNull();
		expect(screen.queryByText("Version saved")).toBeNull();
		expect(screen.queryByText("Export failed")).toBeNull();
		expect(screen.getByRole("button", { name: "ทั้งหมด 4" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "ต้องดู 2" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "ครบกำหนด 1" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "งาน 1" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Export 1" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "โน้ต 1" })).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "Export 1" }));

		expect(onFilterChange).toHaveBeenCalledWith("exports");

		await fireEvent.click(screen.getByRole("button", { name: "โน้ต 1" }));

		expect(onFilterChange).toHaveBeenCalledWith("notes");
	});

	it("hides ScopeToggle, handoff notes, and collaborative mentions in soloMode", () => {
		const item = feedItem({
			kind: "task",
			title: "Typeset page",
			detail: "normal / doing",
			mentions: ["maya", "nina"],
		});

		render(WorkspaceHubPanel, {
			props: {
				projectOpen: true,
				totalEventCount: 1,
				pageEventCount: 1,
				loading: false,
				note: "",
				items: [item],
				scope: "page",
				filter: "all",
				selectedItemId: item.id,
				kindLabel: (kind) => kind.toUpperCase(),
				timeLabel: () => "12:34",
				isActionable: () => true,
				onNoteChange: vi.fn(),
				onScopeChange: vi.fn(),
				onFilterChange: vi.fn(),
				onSync: vi.fn(),
				onAddHandoff: vi.fn(),
				onOpenItem: vi.fn(),
				soloMode: true,
			},
		});

		// Scope toggle and handoff notes drawer should be hidden
		expect(screen.queryByLabelText("ขอบเขตอัปเดตทีม")).toBeNull();
		expect(screen.queryByLabelText("โน้ตส่งต่อทีม")).toBeNull();

		// Collaborative mentions list should be hidden
		expect(screen.queryByLabelText("mention ของอัปเดตที่โฟกัส")).toBeNull();
		expect(screen.queryByText("@maya")).toBeNull();
		expect(screen.queryByText("@nina")).toBeNull();

		// Labels should use solo-friendly words
		expect(screen.getByLabelText("อัปเดตงานที่กำลังโฟกัส")).toBeTruthy();
		expect(screen.getByText("อัปเดตที่ทำต่อได้")).toBeTruthy();
	});
});

describe("WorkQcPanel", () => {
	it("renders QC counts and delegates selected issue rows", async () => {
		const onIssueSelect = vi.fn();
		render(WorkQcPanel, {
			props: {
				projectOpen: true,
				errorCount: 1,
				warningCount: 2,
				infoCount: 3,
				issues: [qcIssue()],
				selectedIssueId: "qc-1",
				severityLabel: (severity) => severity.toUpperCase(),
				onIssueSelect,
			},
		});

				expect(screen.getByText("1 บล็อก")).toBeTruthy();
				expect(screen.getByText("2 ต้องเช็ก")).toBeTruthy();
				expect(screen.getByText("3 ข้อมูล")).toBeTruthy();
				expect(screen.getByRole("button", { name: "แสดง QC ทั้งหมด" }).textContent).toContain("1");
				const focusCard = screen.getByRole("region", { name: "รายการ QC ที่กำลังแก้" });
			expect(within(focusCard).getByText("ERROR")).toBeTruthy();
			expect(within(focusCard).getByText("หน้า 1 มี เลเยอร์ dialogue ว่าง")).toBeTruthy();
			expect(within(focusCard).getByText("เลเยอร์ข้อความ / 1/1")).toBeTruthy();
			expect(within(focusCard).getByText("เปิดเลเยอร์ข้อความแล้วแก้ copy ให้เรียบร้อย")).toBeTruthy();
				await fireEvent.click(within(focusCard).getByRole("button", { name: /แก้ข้อความ สำหรับ QC หน้า 1/ }));
			expect(onIssueSelect).toHaveBeenCalledWith("qc-1");

			await fireEvent.click(screen.getByRole("button", { name: /เปิด QC หน้า 1 มี เลเยอร์ dialogue ว่าง/ }));
			expect(onIssueSelect).toHaveBeenCalledWith("qc-1");
	});

	it("labels no-text QC issues as text placement actions", async () => {
		const onIssueSelect = vi.fn();
		render(WorkQcPanel, {
			props: {
				projectOpen: true,
				errorCount: 0,
				warningCount: 1,
				infoCount: 0,
				issues: [
					qcIssue({
						id: "page-0-without-text",
						code: "page_without_text",
						severity: "warning",
						messageCode: "page_without_text",
						messageValues: { page: 1 },
						layerId: undefined,
					}),
				],
				selectedIssueId: "page-0-without-text",
				severityLabel: (severity) => severity.toUpperCase(),
				onIssueSelect,
			},
		});

			const focusCard = screen.getByRole("region", { name: "รายการ QC ที่กำลังแก้" });
			expect(within(focusCard).getByText("วางกล่องข้อความแรกบนหน้านี้ แล้วเช็กคุณภาพจะผ่านหลังมีข้อความ")).toBeTruthy();
				await fireEvent.click(within(focusCard).getByRole("button", { name: /วางข้อความ สำหรับ QC หน้า 1/ }));
		expect(onIssueSelect).toHaveBeenCalledWith("page-0-without-text");
	});

	it("renders duplicate QC ids from older project data without a keyed list crash", () => {
		const onIssueSelect = vi.fn();
		render(WorkQcPanel, {
			props: {
				projectOpen: true,
				errorCount: 0,
				warningCount: 2,
				infoCount: 0,
				issues: [
					qcIssue({
						id: "page-0-layer-duplicate-unchanged",
						code: "unchanged_source_text",
						messageCode: "unchanged_source_text",
						messageValues: { page: 1 },
						severity: "warning",
					}),
					qcIssue({
						id: "page-0-layer-duplicate-unchanged",
						code: "unchanged_source_text",
						messageCode: "unchanged_source_text",
						messageValues: { page: 2 },
						severity: "warning",
					}),
				],
				selectedIssueId: "page-0-layer-duplicate-unchanged",
				severityLabel: (severity) => severity.toUpperCase(),
				onIssueSelect,
			},
		});

		// Both duplicate-id rows render their (localized) message without a keyed-list crash.
		expect(screen.getAllByText("หน้า 1 อาจยังมีข้อความต้นฉบับที่ยังไม่แปล").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("หน้า 2 อาจยังมีข้อความต้นฉบับที่ยังไม่แปล")).toBeTruthy();
	});

	it("keeps the selected issue visible and delegates previous and next navigation", async () => {
		const onIssueSelect = vi.fn();
		// Each issue renders a distinct localized message via its page number, so the
		// "Issue N" markers below map to `หน้า N อาจยังมีข้อความต้นฉบับที่ยังไม่แปล`.
		const issueText = (n: number) => `หน้า ${n} อาจยังมีข้อความต้นฉบับที่ยังไม่แปล`;
		const issues = Array.from({ length: 8 }, (_, index) =>
			qcIssue({
				id: `qc-${index + 1}`,
				code: "unchanged_source_text",
				messageCode: "unchanged_source_text",
				messageValues: { page: index + 1 },
				severity: index % 2 === 0 ? "warning" : "error",
			})
		);

		render(WorkQcPanel, {
			props: {
				projectOpen: true,
				errorCount: 4,
				warningCount: 4,
				infoCount: 0,
				issues,
				selectedIssueId: "qc-5",
				severityLabel: (severity) => severity.toUpperCase(),
				onIssueSelect,
			},
		});

		expect(screen.getByText("5/8")).toBeTruthy();
		expect(screen.queryByText(issueText(1))).toBeNull();
		expect(screen.getAllByText(issueText(5)).length).toBeGreaterThan(1);
		expect(screen.getByText(issueText(8))).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "QC ถัดไป" }));
		await fireEvent.click(screen.getByRole("button", { name: "QC ก่อนหน้า" }));

		expect(onIssueSelect).toHaveBeenCalledWith("qc-6");
		expect(onIssueSelect).toHaveBeenCalledWith("qc-4");
	});

	it("filters QC rows by severity and navigates inside the active filter", async () => {
		const onIssueSelect = vi.fn();
		render(WorkQcPanel, {
			props: {
				projectOpen: true,
				errorCount: 1,
				warningCount: 2,
				infoCount: 1,
				// Distinct localized messages per row (by page number) so the
				// severity-filter assertions can target a specific rendered string.
				issues: [
					qcIssue({ id: "qc-error", severity: "error", code: "unchanged_source_text", messageCode: "unchanged_source_text", messageValues: { page: 1 } }),
					qcIssue({ id: "qc-warning-1", severity: "warning", code: "unchanged_source_text", messageCode: "unchanged_source_text", messageValues: { page: 2 } }),
					qcIssue({ id: "qc-warning-2", severity: "warning", code: "unchanged_source_text", messageCode: "unchanged_source_text", messageValues: { page: 3 } }),
					qcIssue({ id: "qc-info", severity: "info", code: "unchanged_source_text", messageCode: "unchanged_source_text", messageValues: { page: 4 } }),
				],
				selectedIssueId: null,
				severityLabel: (severity) => severity.toUpperCase(),
				onIssueSelect,
			},
		});

			await fireEvent.click(screen.getByRole("button", { name: "แสดง QC ต้องเช็ก" }));

		const blockingText = "หน้า 1 อาจยังมีข้อความต้นฉบับที่ยังไม่แปล";
		const firstWarning = "หน้า 2 อาจยังมีข้อความต้นฉบับที่ยังไม่แปล";
		const secondWarning = "หน้า 3 อาจยังมีข้อความต้นฉบับที่ยังไม่แปล";
		const infoText = "หน้า 4 อาจยังมีข้อความต้นฉบับที่ยังไม่แปล";
		expect(screen.queryByText(blockingText)).toBeNull();
			const focusCard = screen.getByRole("region", { name: "รายการ QC ที่กำลังแก้" });
		expect(within(focusCard).getByText("WARNING")).toBeTruthy();
		expect(within(focusCard).getByText(firstWarning)).toBeTruthy();
		expect(screen.getAllByText(firstWarning).length).toBeGreaterThan(1);
		expect(screen.getByText(secondWarning)).toBeTruthy();
		expect(screen.queryByText(infoText)).toBeNull();
		expect(screen.getByText("1/2")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button", { name: "QC ถัดไป" }));

		expect(onIssueSelect).toHaveBeenCalledWith("qc-warning-1");
	});

	it("renders QC empty states", () => {
		const baseProps = {
			errorCount: 0,
			warningCount: 0,
			infoCount: 0,
			issues: [],
			selectedIssueId: null,
			severityLabel: (severity: QcIssue["severity"]) => severity,
			onIssueSelect: vi.fn(),
		};

		const { unmount } = render(WorkQcPanel, {
			props: {
				...baseProps,
				projectOpen: false,
			},
		});
		expect(screen.getByText("เปิดงานเพื่อรัน QC")).toBeTruthy();
		unmount();

		render(WorkQcPanel, {
			props: {
				...baseProps,
				projectOpen: true,
			},
		});
		expect(screen.getByText("ไม่มีรายการ QC ที่ต้องแก้ในหน้านี้")).toBeTruthy();
	});
});
