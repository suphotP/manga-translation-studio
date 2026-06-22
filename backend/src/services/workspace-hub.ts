import { v4 as uuid } from "uuid";
import type { ExportRun, ProjectState, WorkflowTask, WorkflowTaskPriority, WorkspaceFeedItem, WorkspaceMessage } from "../types/index.js";
import { formatAssigneeHandle, normalizeAssigneeHandle } from "./assignees.js";
import { extractProjectCommentMentions } from "./comments.js";
import { normalizeWorkflowTaskPriority } from "./workflow.js";

export const MAX_WORKSPACE_MESSAGES = 500;
export const MAX_WORKSPACE_FEED_ITEMS = 160;
export const WORKSPACE_DUE_SOON_MS = 24 * 60 * 60 * 1000;

const PRIORITY_SORT_RANK: Record<WorkflowTaskPriority, number> = {
	urgent: 0,
	high: 1,
	normal: 2,
};

const SEVERITY_SORT_RANK: Record<NonNullable<WorkspaceFeedItem["severity"]>, number> = {
	error: 0,
	warning: 1,
	info: 2,
};

function priorityLabel(priority: WorkflowTaskPriority): string {
	if (priority === "urgent") return "urgent";
	if (priority === "high") return "high";
	return "normal";
}

type TaskDueState = NonNullable<WorkspaceFeedItem["dueState"]>;

function taskSeverity(
	priority: WorkflowTaskPriority,
	status: string,
	dueState: TaskDueState | undefined,
): WorkspaceFeedItem["severity"] {
	if (dueState === "overdue") return "error";
	if (priority === "urgent") return "error";
	if (priority === "high" || status === "review" || dueState === "soon") return "warning";
	return "info";
}

function taskDueState(task: WorkflowTask, now = Date.now()): TaskDueState | undefined {
	if (!task.dueAt || task.status === "done") return undefined;
	const dueTime = Date.parse(task.dueAt);
	if (!Number.isFinite(dueTime)) return undefined;
	if (dueTime < now) return "overdue";
	if (dueTime - now <= WORKSPACE_DUE_SOON_MS) return "soon";
	return "scheduled";
}

function taskDueDetail(task: WorkflowTask, dueState: TaskDueState | undefined): string | null {
	if (!task.dueAt || !dueState) return null;
	const label = dueState === "overdue"
		? "overdue"
		: dueState === "soon"
			? "due soon"
			: "due";
	return `${label} ${task.dueAt.slice(0, 10)}`;
}

function taskDetail(task: WorkflowTask, priority: WorkflowTaskPriority, dueState: TaskDueState | undefined): string {
	const parts = [priorityLabel(priority), task.status];
	const assignee = normalizeAssigneeHandle(task.assignee);
	if (assignee) parts.push(formatAssigneeHandle(assignee));
	const dueDetail = taskDueDetail(task, dueState);
	if (dueDetail) parts.push(dueDetail);
	return parts.join(" / ");
}

function exportRunTargetProfileLabel(run: ExportRun): string {
	if (run.targetProfile === "public-export") return "Public/Export";
	if (run.targetProfile === "draft-internal") return "Draft/Internal";
	return "";
}

function exportRunDetail(run: ExportRun): string {
	const pageCount = run.pageCount;
	const scope = pageCount === 1 ? "1 page" : `${pageCount} pages`;
	const target = exportRunTargetProfileLabel(run);
	return [target, scope, (run.error ?? run.message) || run.filename].filter(Boolean).join(" / ");
}

function exportRunMissingPageIndexes(state: ProjectState, run: ExportRun): number[] {
	return Array.from(new Set(run.pageIndexes ?? []))
		.filter((pageIndex) => Number.isInteger(pageIndex) && pageIndex >= 0 && !state.pages[pageIndex])
		.sort((a, b) => a - b);
}

function exportRunLiveSinglePageIndex(state: ProjectState, run: ExportRun): number | undefined {
	if (run.pageIndexes.length !== 1) return undefined;
	const pageIndex = run.pageIndexes[0];
	if (pageIndex === undefined) return undefined;
	return Number.isInteger(pageIndex) && pageIndex >= 0 && state.pages[pageIndex] ? pageIndex : undefined;
}

function attentionRank(item: WorkspaceFeedItem): number {
	const priorityRank = item.priority ? PRIORITY_SORT_RANK[item.priority] : Number.MAX_SAFE_INTEGER;
	const severityRank = item.severity ? SEVERITY_SORT_RANK[item.severity] : Number.MAX_SAFE_INTEGER;
	return Math.min(priorityRank, severityRank);
}

/** Like {@link normalizeWorkspaceMessages} but returns TRUE iff it changed
 *  `state.workspaceMessages` (small capped array compare — no whole-state hash). */
export function normalizeWorkspaceMessagesChanged(state: ProjectState): boolean {
	const prev = JSON.stringify(state.workspaceMessages);
	const messages = Array.isArray(state.workspaceMessages) ? state.workspaceMessages : [];
	state.workspaceMessages = messages.slice(0, MAX_WORKSPACE_MESSAGES).map((message) => ({
		...message,
		mentions: Array.isArray(message.mentions) ? message.mentions : extractProjectCommentMentions(message.body),
	}));
	return JSON.stringify(state.workspaceMessages) !== prev;
}

export function normalizeWorkspaceMessages(state: ProjectState): WorkspaceMessage[] {
	normalizeWorkspaceMessagesChanged(state);
	return state.workspaceMessages;
}

export function createWorkspaceMessage(input: {
	pageIndex?: number;
	body: string;
	author?: string;
	linkedTaskId?: string;
	linkedCommentId?: string;
	region?: { x: number; y: number; w: number; h: number };
}): WorkspaceMessage {
	const now = new Date().toISOString();
	return {
		id: uuid(),
		pageIndex: input.pageIndex,
		body: input.body,
		author: input.author ?? "local-user",
		mentions: extractProjectCommentMentions(input.body),
		linkedTaskId: input.linkedTaskId,
		linkedCommentId: input.linkedCommentId,
		region: input.region,
		createdAt: now,
		updatedAt: now,
	};
}

export function buildWorkspaceFeed(state: ProjectState): WorkspaceFeedItem[] {
	const items: WorkspaceFeedItem[] = [];

	for (const message of normalizeWorkspaceMessages(state)) {
		items.push({
			id: `message:${message.id}`,
			kind: "message",
			sourceId: message.id,
			pageIndex: message.pageIndex,
			title: "Handoff note",
			detail: message.body,
			actor: message.author,
			createdAt: message.createdAt,
			mentions: message.mentions,
			status: "open",
		});
	}

	for (const comment of state.comments ?? []) {
		if (comment.status !== "open") continue;
		items.push({
			id: `comment:${comment.id}`,
			kind: "comment",
			sourceId: comment.id,
			pageIndex: comment.pageIndex,
			title: "Open review comment",
			detail: comment.body,
			actor: comment.author,
			createdAt: comment.createdAt,
			mentions: comment.mentions,
			status: comment.status,
			severity: "warning",
		});
	}

	for (const decision of state.reviewDecisions ?? []) {
		items.push({
			id: `review:${decision.id}`,
			kind: "review_decision",
			sourceId: decision.id,
			pageIndex: decision.pageIndex,
			title: decision.status === "approved" ? "Page approved" : "Changes requested",
			detail: decision.body ?? "No note",
			actor: decision.actor,
			createdAt: decision.createdAt,
			status: decision.status,
			severity: decision.status === "approved" ? "info" : "warning",
		});
	}

	for (const review of state.versionReviewRequests ?? []) {
		items.push({
			id: `version-review:${review.id}`,
			kind: "version_review",
			sourceId: review.id,
			versionId: review.versionId,
			title: review.status === "open"
				? "Version review requested"
				: review.status === "approved"
					? "Version approved"
					: "Version changes requested",
			detail: review.body ?? review.versionId.slice(0, 18),
			actor: review.reviewer ?? review.requester,
			createdAt: review.updatedAt,
			status: review.status,
			severity: review.status === "approved" ? "info" : "warning",
			mentions: review.mentions,
		});
	}

	for (const marker of state.aiReviewMarkers ?? []) {
		if (marker.status === "accepted" || marker.status === "applied") continue;
		items.push({
			id: `ai:${marker.id}`,
			kind: "ai_marker",
			sourceId: marker.id,
			pageIndex: marker.pageIndex,
			title: `AI ${marker.tier}`,
			detail: marker.error ?? marker.status,
			actor: "ai",
			createdAt: marker.updatedAt,
			status: marker.status,
			severity: marker.status === "failed" ? "error" : "warning",
		});
	}

	for (const task of state.tasks ?? []) {
		if (task.status === "done") continue;
		const priority = normalizeWorkflowTaskPriority(task.priority);
		const dueState = taskDueState(task);
		items.push({
			id: `task:${task.id}`,
			kind: "task",
			sourceId: task.id,
			pageIndex: task.pageIndex,
			title: task.title,
			detail: taskDetail(task, priority, dueState),
			actor: normalizeAssigneeHandle(task.assignee),
			createdAt: task.updatedAt,
			status: task.status,
			severity: taskSeverity(priority, task.status, dueState),
			priority,
			dueAt: task.dueAt,
			dueState,
		});
	}

	for (const run of state.exportRuns ?? []) {
		const pageIndex = exportRunLiveSinglePageIndex(state, run);
		const missingPageIndexes = exportRunMissingPageIndexes(state, run);
		const detail = exportRunDetail(run);
		items.push({
			id: `export:${run.id}`,
			kind: "export_run",
			sourceId: run.id,
			pageIndex,
			title: run.status === "error" ? "Export failed" : "Export completed",
			detail: missingPageIndexes.length
				? `${detail} / ${missingPageIndexes.length} missing page${missingPageIndexes.length === 1 ? "" : "s"}`
				: detail,
			actor: "export",
			createdAt: run.completedAt || run.createdAt,
			status: run.status,
			severity: run.status === "error" ? "error" : "info",
		});
	}

	for (const event of state.activityLog ?? []) {
		items.push({
			id: `activity:${event.id}`,
			kind: "activity",
			sourceId: event.id,
			pageIndex: event.pageIndex,
			title: event.message,
			// Forward the structured localized-title key/params (additive) so the
			// frontend renders the activity message in the viewer's locale; `title`
			// stays the back-compatible fallback for older events / clients.
			...(event.messageKey ? { titleKey: event.messageKey } : {}),
			...(event.messageParams ? { titleParams: event.messageParams } : {}),
			detail: event.type,
			actor: event.actor,
			createdAt: event.createdAt,
			status: event.type,
		});
	}

	return items
		.sort((a, b) => {
			const attentionDelta = attentionRank(a) - attentionRank(b);
			if (attentionDelta !== 0) return attentionDelta;
			return Date.parse(b.createdAt) - Date.parse(a.createdAt);
		})
		.slice(0, MAX_WORKSPACE_FEED_ITEMS);
}
