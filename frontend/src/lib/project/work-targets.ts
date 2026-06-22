import type { WorkspaceFeedItem } from "$lib/types.js";
import type { WorkInboxItem } from "./work-inbox.js";

export type WorkTargetOrigin = "inbox" | "workspace";

export type WorkTargetKind =
	| "ai_marker"
	| "comment"
	| "task"
	| "qc_issue"
	| "review_decision"
	| "version_review"
	| "export_run";

export interface WorkTarget {
	id: string;
	origin: WorkTargetOrigin;
	kind: WorkTargetKind;
	sourceId: string;
	pageIndex?: number;
	versionId?: string;
	title: string;
}

export function workInboxItemToTarget(item: WorkInboxItem): WorkTarget {
	return {
		id: item.id,
		origin: "inbox",
		kind: item.kind === "review_task" || item.kind === "workflow_task" ? "task" : item.kind === "qc" ? "qc_issue" : item.kind,
		sourceId: item.sourceId,
		pageIndex: item.pageIndex,
		// `title` on a WorkTarget is opaque routing metadata, never rendered. Carry
		// the inbox item's stable, locale-neutral title CODE (the composed Thai
		// display title now lives in the consumers' `$_()` calls).
		title: item.titleCode,
	};
}

export function workspaceFeedItemToTarget(item: WorkspaceFeedItem): WorkTarget | null {
	if (
		item.kind !== "comment"
		&& item.kind !== "task"
		&& item.kind !== "review_decision"
		&& item.kind !== "ai_marker"
		&& item.kind !== "version_review"
		&& item.kind !== "export_run"
	) {
		return null;
	}

	return {
		id: item.id,
		origin: "workspace",
		kind: item.kind,
		sourceId: item.sourceId,
		pageIndex: item.pageIndex,
		versionId: item.versionId,
		title: item.title,
	};
}

export function isWorkspaceFeedItemActionable(item: WorkspaceFeedItem): boolean {
	return workspaceFeedItemToTarget(item) !== null;
}

export function workspaceFeedItemActionLabel(item: WorkspaceFeedItem): string {
	switch (item.kind) {
		case "comment":
			return "เปิดโน้ต";
		case "task":
			return "เปิดงาน";
		case "review_decision":
			return "เปิดผลรีวิว";
		case "ai_marker":
			return "ตรวจ AI";
		case "version_review":
			return "เปิดเวอร์ชัน";
		case "export_run":
			return "เปิด Export";
		case "message":
			return "โน้ตส่งต่อ";
		case "activity":
			return "อ่านบันทึก";
	}
}
