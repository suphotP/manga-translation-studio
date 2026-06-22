import {
	pageNeedsAttention,
	type PageBatchSummary,
	type PageWorkStatus,
	type PageWorkSummary,
} from "$lib/project/page-work-summary.js";

export type ChapterDashboardLaneId = PageWorkStatus | "attention" | "overdue" | "urgent" | "high";

export interface ChapterDashboardLane {
	id: ChapterDashboardLaneId;
	label: string;
	count: number;
	firstPageIndex: number | null;
	firstPageLabel: string;
	tone: "blocked" | "review" | "working" | "ready" | "empty" | "attention" | "urgent" | "high";
}

export interface ChapterDashboardSignals {
	assetScanning: number;
	assetBlocked: number;
	openComments: number;
	aiAttention: number;
	qcErrors: number;
	qcWarnings: number;
	openTasks: number;
	dueTasks: number;
	overdueTasks: number;
	urgentTasks: number;
	highTasks: number;
	assignees: number;
}

export interface GroupedSignals {
	assets: {
		assetBlocked: number;
		assetScanning: number;
	};
	qc: {
		qcErrors: number;
		qcWarnings: number;
	};
	aiComments: {
		aiAttention: number;
		openComments: number;
	};
	tasks: {
		overdueTasks: number;
		dueTasks: number;
		urgentTasks: number;
		highTasks: number;
		openTasks: number;
	};
	people: {
		assignees: number;
	};
}

export function groupChapterDashboardSignals(signals: ChapterDashboardSignals): GroupedSignals {
	return {
		assets: {
			assetBlocked: signals.assetBlocked,
			assetScanning: signals.assetScanning,
		},
		qc: {
			qcErrors: signals.qcErrors,
			qcWarnings: signals.qcWarnings,
		},
		aiComments: {
			aiAttention: signals.aiAttention,
			openComments: signals.openComments,
		},
		tasks: {
			overdueTasks: signals.overdueTasks,
			dueTasks: signals.dueTasks,
			urgentTasks: signals.urgentTasks,
			highTasks: signals.highTasks,
			openTasks: signals.openTasks,
		},
		people: {
			assignees: signals.assignees,
		},
	};
}


export interface ChapterDashboard {
	totalPages: number;
	totalLayers: number;
	exportReadyCount: number;
	exportReadyPercent: number;
	attentionCount: number;
	lanes: ChapterDashboardLane[];
	signals: ChapterDashboardSignals;
	primaryLane: ChapterDashboardLane;
}

const LANE_LABELS: Record<ChapterDashboardLaneId, string> = {
	attention: "Needs work",
	overdue: "Overdue",
	urgent: "Urgent",
	high: "High",
	blocked: "Blocked",
	review: "ตรวจ",
	working: "Working",
	empty: "No text",
	ready: "Ready",
};

const LANE_TONES: Record<ChapterDashboardLaneId, ChapterDashboardLane["tone"]> = {
	attention: "attention",
	overdue: "urgent",
	urgent: "urgent",
	high: "high",
	blocked: "blocked",
	review: "review",
	working: "working",
	empty: "empty",
	ready: "ready",
};

function buildLane(id: ChapterDashboardLaneId, summaries: PageWorkSummary[]): ChapterDashboardLane {
	const members = summaries.filter((summary) => {
		if (id === "attention") return pageNeedsAttention(summary);
		if (id === "overdue") return summary.overdueTaskCount > 0;
		if (id === "urgent") return summary.urgentTaskCount > 0;
		if (id === "high") return summary.urgentTaskCount === 0 && summary.highTaskCount > 0;
		if (id === "empty") return summary.layerCount === 0;
		return summary.status === id;
	});
	const first = members[0] ?? null;
	return {
		id,
		label: LANE_LABELS[id],
		count: members.length,
		firstPageIndex: first?.pageIndex ?? null,
		firstPageLabel: first ? `P${first.pageNumber}` : "-",
		tone: LANE_TONES[id],
	};
}

function pickPrimaryLane(lanes: ChapterDashboardLane[]): ChapterDashboardLane {
	return lanes.find((lane) => lane.id === "overdue" && lane.count > 0)
		?? lanes.find((lane) => lane.id === "urgent" && lane.count > 0)
		?? lanes.find((lane) => lane.id === "blocked" && lane.count > 0)
		?? lanes.find((lane) => lane.id === "high" && lane.count > 0)
		?? lanes.find((lane) => lane.id === "review" && lane.count > 0)
		?? lanes.find((lane) => lane.id === "empty" && lane.count > 0)
		?? lanes.find((lane) => lane.id === "ready" && lane.count > 0)
		?? lanes[0];
}

export function buildChapterDashboard(
	summaries: PageWorkSummary[],
	batchSummary: PageBatchSummary,
): ChapterDashboard {
	const totalPages = summaries.length;
	const exportReadyPercent = totalPages > 0
		? Math.round((batchSummary.exportReadyCount / totalPages) * 100)
		: 0;
	const assignees = new Set<string>();
	for (const summary of summaries) {
		for (const assignee of summary.assignees) assignees.add(assignee);
	}
	const lanes: ChapterDashboardLane[] = [
		buildLane("attention", summaries),
		buildLane("overdue", summaries),
		buildLane("urgent", summaries),
		buildLane("high", summaries),
		buildLane("blocked", summaries),
		buildLane("review", summaries),
		buildLane("empty", summaries),
		buildLane("ready", summaries),
	];

	return {
		totalPages,
		totalLayers: batchSummary.layerCount,
		exportReadyCount: batchSummary.exportReadyCount,
		exportReadyPercent,
		attentionCount: batchSummary.attentionCount,
		lanes,
		signals: {
			assetScanning: summaries.reduce(
				(sum, summary) => sum + (summary.assetIntegrity?.status === "scanning" ? 1 : 0),
				0,
			),
			assetBlocked: summaries.reduce(
				(sum, summary) => sum + (summary.assetIntegrity?.status === "blocked" ? 1 : 0),
				0,
			),
			openComments: batchSummary.commentCount,
			aiAttention: batchSummary.aiAttentionCount,
			qcErrors: summaries.reduce((sum, summary) => sum + summary.qcErrorCount, 0),
			qcWarnings: summaries.reduce((sum, summary) => sum + summary.qcWarningCount, 0),
			openTasks: summaries.reduce((sum, summary) => sum + summary.taskOpenCount, 0),
			dueTasks: batchSummary.dueTaskCount,
			overdueTasks: batchSummary.overdueTaskCount,
			urgentTasks: batchSummary.urgentTaskCount,
			highTasks: batchSummary.highTaskCount,
			assignees: assignees.size,
		},
		primaryLane: pickPrimaryLane(lanes),
	};
}
