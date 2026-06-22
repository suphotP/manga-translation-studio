import type { WorkspaceFeedItem } from "$lib/types.js";

export const WORKSPACE_FEED_FILTERS = [
	{ id: "all", label: "ทั้งหมด" },
	{ id: "attention", label: "ต้องดู" },
	{ id: "due", label: "ครบกำหนด" },
	{ id: "tasks", label: "งาน" },
	{ id: "exports", label: "Export" },
	{ id: "notes", label: "โน้ต" },
] as const;

export type WorkspaceFeedFilter = (typeof WORKSPACE_FEED_FILTERS)[number]["id"];

export function isWorkspaceFeedAttention(item: WorkspaceFeedItem): boolean {
	return item.severity === "error"
		|| item.severity === "warning"
		|| item.priority === "urgent"
		|| item.priority === "high"
		|| item.dueState === "overdue"
		|| item.dueState === "soon";
}

export function workspaceFeedFilterMatches(item: WorkspaceFeedItem, filter: WorkspaceFeedFilter): boolean {
	if (filter === "all") return true;
	if (filter === "attention") return isWorkspaceFeedAttention(item);
	if (filter === "due") return Boolean(item.dueAt);
	if (filter === "tasks") return item.kind === "task";
	if (filter === "exports") return item.kind === "export_run";
	return item.kind === "message" || item.kind === "comment";
}

export function filterWorkspaceFeedItems(
	items: readonly WorkspaceFeedItem[],
	filter: WorkspaceFeedFilter,
): WorkspaceFeedItem[] {
	return items.filter((item) => workspaceFeedFilterMatches(item, filter));
}

export function countWorkspaceFeedFilterItems(
	items: readonly WorkspaceFeedItem[],
	filter: WorkspaceFeedFilter,
): number {
	return items.reduce((count, item) => count + (workspaceFeedFilterMatches(item, filter) ? 1 : 0), 0);
}

export function workspaceFeedFilterEmptyCopy(filter: WorkspaceFeedFilter, scope: "page" | "all"): string {
	const target = scope === "all" ? "ในงานนี้" : "บนหน้านี้";
	if (filter === "attention") return `ยังไม่มีอัปเดตที่ต้องดู${target}`;
	if (filter === "due") return `ยังไม่มีงานครบกำหนด${target}`;
	if (filter === "tasks") return `ยังไม่มีแถวงาน${target}`;
	if (filter === "exports") return `ยังไม่มีประวัติ Export ${target}`;
	if (filter === "notes") return `ยังไม่มีโน้ต${target}`;
	return scope === "all" ? "งานนี้ยังไม่มีอัปเดตทีม" : "หน้านี้ยังไม่มีอัปเดตทีม";
}
