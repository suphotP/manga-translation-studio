export const WORKSPACE_HELP_TOPIC_IDS = [
	"dashboard",
	"library",
	"workboard",
	"dutyInbox",
	"reports",
	"settings",
] as const;

export type WorkspaceHelpTopicId = typeof WORKSPACE_HELP_TOPIC_IDS[number];

export interface WorkspaceHelpTopic {
	id: WorkspaceHelpTopicId;
	title: string;
	oneLiner: string;
	steps: readonly string[];
}

export interface ResolvedWorkspaceHelpTopic {
	title: string;
	oneLiner: string;
	steps: string[];
}

type InterpolationValue = string | number | boolean | Date | null | undefined;
export type WorkspaceHelpTranslate = (
	key: string,
	options?: { values?: Record<string, InterpolationValue> },
) => string;

function topicKeys(id: WorkspaceHelpTopicId): WorkspaceHelpTopic {
	return {
		id,
		title: `workspaceHelp.${id}.title`,
		oneLiner: `workspaceHelp.${id}.oneLiner`,
		steps: [
			`workspaceHelp.${id}.steps.step1`,
			`workspaceHelp.${id}.steps.step2`,
			`workspaceHelp.${id}.steps.step3`,
		],
	};
}

export const WORKSPACE_HELP_TOPICS: Record<WorkspaceHelpTopicId, WorkspaceHelpTopic> = {
	dashboard: topicKeys("dashboard"),
	library: topicKeys("library"),
	workboard: topicKeys("workboard"),
	dutyInbox: topicKeys("dutyInbox"),
	reports: topicKeys("reports"),
	settings: topicKeys("settings"),
};

export function getWorkspaceHelpTopic(id: WorkspaceHelpTopicId): WorkspaceHelpTopic {
	return WORKSPACE_HELP_TOPICS[id];
}

export function resolveWorkspaceHelpTopic(
	id: WorkspaceHelpTopicId,
	t: WorkspaceHelpTranslate,
): ResolvedWorkspaceHelpTopic {
	const topic = getWorkspaceHelpTopic(id);
	return {
		title: t(topic.title),
		oneLiner: t(topic.oneLiner),
		steps: topic.steps.map((key) => t(key)),
	};
}

export function resolveWorkspaceHelpTopics(
	t: WorkspaceHelpTranslate,
): Record<WorkspaceHelpTopicId, ResolvedWorkspaceHelpTopic> {
	const resolved = {} as Record<WorkspaceHelpTopicId, ResolvedWorkspaceHelpTopic>;
	for (const id of WORKSPACE_HELP_TOPIC_IDS) {
		resolved[id] = resolveWorkspaceHelpTopic(id, t);
	}
	return resolved;
}

const WORKSPACE_VIEW_HELP_TOPIC: Record<string, WorkspaceHelpTopicId> = {
	dashboard: "dashboard",
	library: "library",
	work: "workboard",
	reports: "reports",
	settings: "settings",
};

export function getWorkspaceHelpTopicIdForView(view: string): WorkspaceHelpTopicId | null {
	return WORKSPACE_VIEW_HELP_TOPIC[view] ?? null;
}
