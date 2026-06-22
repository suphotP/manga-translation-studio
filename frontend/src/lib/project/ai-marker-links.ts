import type { AiReviewMarker, ProjectComment, WorkflowTask } from "$lib/types.js";

export interface AiMarkerLinkSummary {
	commentIds: string[];
	taskIds: string[];
	liveCommentIds: string[];
	liveTaskIds: string[];
	missingCommentIds: string[];
	missingTaskIds: string[];
	hasMissingLinks: boolean;
}

export interface AiMarkerLinkedReferenceIssue {
	problem: "missing-comment" | "missing-task" | "missing-links";
	missingCommentIds: string[];
	missingTaskIds: string[];
	message: string;
}

function uniqueStringIds(ids: string[] | undefined): string[] {
	return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
}

function sampleIds(ids: readonly string[]): string {
	return ids.slice(0, 3).join(", ");
}

export function summarizeAiMarkerLinks(
	marker: AiReviewMarker,
	comments: readonly ProjectComment[] = [],
	tasks: readonly WorkflowTask[] = [],
): AiMarkerLinkSummary {
	const commentIds = uniqueStringIds(marker.linkedCommentIds);
	const taskIds = uniqueStringIds(marker.linkedTaskIds);
	const commentIdSet = new Set(comments.map((comment) => comment.id));
	const taskIdSet = new Set(tasks.map((task) => task.id));
	const liveCommentIds = commentIds.filter((id) => commentIdSet.has(id));
	const liveTaskIds = taskIds.filter((id) => taskIdSet.has(id));
	const missingCommentIds = commentIds.filter((id) => !commentIdSet.has(id));
	const missingTaskIds = taskIds.filter((id) => !taskIdSet.has(id));

	return {
		commentIds,
		taskIds,
		liveCommentIds,
		liveTaskIds,
		missingCommentIds,
		missingTaskIds,
		hasMissingLinks: missingCommentIds.length > 0 || missingTaskIds.length > 0,
	};
}

export function getAiMarkerLinkedReferenceIssue(
	marker: AiReviewMarker,
	comments: readonly ProjectComment[] = [],
	tasks: readonly WorkflowTask[] = [],
): AiMarkerLinkedReferenceIssue | null {
	const summary = summarizeAiMarkerLinks(marker, comments, tasks);
	if (!summary.hasMissingLinks) return null;

	if (summary.missingCommentIds.length && summary.missingTaskIds.length) {
		return {
			problem: "missing-links",
			missingCommentIds: summary.missingCommentIds,
			missingTaskIds: summary.missingTaskIds,
			message: `ผล AI นี้มีลิงก์ที่หาย: โน้ต ${sampleIds(summary.missingCommentIds)} และงาน ${sampleIds(summary.missingTaskIds)}; ล้างลิงก์หรือสร้างงานติดตามใหม่`,
		};
	}

	if (summary.missingCommentIds.length) {
		return {
			problem: "missing-comment",
			missingCommentIds: summary.missingCommentIds,
			missingTaskIds: [],
			message: `Comment ${sampleIds(summary.missingCommentIds)} ที่ผูกกับผล AI หาย; ล้างลิงก์หรือเพิ่มโน้ตแก้ใหม่`,
		};
	}

	return {
		problem: "missing-task",
		missingCommentIds: [],
		missingTaskIds: summary.missingTaskIds,
		message: `งาน ${sampleIds(summary.missingTaskIds)} ที่ผูกกับผล AI หาย; ล้างลิงก์หรือสร้างงานแก้ใหม่`,
	};
}
