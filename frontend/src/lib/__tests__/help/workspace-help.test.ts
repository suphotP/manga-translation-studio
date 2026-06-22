import { describe, expect, it } from "vitest";

import en from "$lib/i18n/locales/en.json";
import th from "$lib/i18n/locales/th.json";
import id from "$lib/i18n/locales/id.json";
import ms from "$lib/i18n/locales/ms.json";
import {
	WORKSPACE_HELP_TOPIC_IDS,
	WORKSPACE_HELP_TOPICS,
	getWorkspaceHelpTopicIdForView,
	resolveWorkspaceHelpTopic,
	resolveWorkspaceHelpTopics,
	type WorkspaceHelpTopicId,
} from "$lib/help/workspace-help.js";

type Dict = Record<string, unknown>;

const REQUIRED_TOPICS: readonly WorkspaceHelpTopicId[] = [
	"dashboard",
	"library",
	"workboard",
	"dutyInbox",
	"reports",
	"settings",
];

const LOCALES: Record<string, Dict> = {
	en: en as Dict,
	th: th as Dict,
	id: id as Dict,
	ms: ms as Dict,
};

function readMessage(dict: Dict, key: string): string | undefined {
	let cursor: unknown = dict;
	for (const part of key.split(".")) {
		if (!cursor || typeof cursor !== "object" || !(part in cursor)) return undefined;
		cursor = (cursor as Dict)[part];
	}
	return typeof cursor === "string" ? cursor : undefined;
}

function keysForTopic(topicId: WorkspaceHelpTopicId): string[] {
	const topic = WORKSPACE_HELP_TOPICS[topicId];
	return [topic.title, topic.oneLiner, ...topic.steps];
}

function allHelpKeys(): string[] {
	return WORKSPACE_HELP_TOPIC_IDS.flatMap(keysForTopic);
}

function translatorFor(dict: Dict) {
	return (key: string) => readMessage(dict, key) ?? key;
}

describe("workspace help copy map", () => {
	it("covers the main workspace surfaces in a stable order", () => {
		expect(WORKSPACE_HELP_TOPIC_IDS).toEqual(REQUIRED_TOPICS);
		expect(Object.keys(WORKSPACE_HELP_TOPICS)).toEqual(REQUIRED_TOPICS);
	});

	it("uses only workspaceHelp i18n keys and three ordered steps per topic", () => {
		for (const id of REQUIRED_TOPICS) {
			const topic = WORKSPACE_HELP_TOPICS[id];
			expect(topic.id).toBe(id);
			expect(topic.title).toBe(`workspaceHelp.${id}.title`);
			expect(topic.oneLiner).toBe(`workspaceHelp.${id}.oneLiner`);
			expect(topic.steps).toEqual([
				`workspaceHelp.${id}.steps.step1`,
				`workspaceHelp.${id}.steps.step2`,
				`workspaceHelp.${id}.steps.step3`,
			]);
		}
		expect(new Set(allHelpKeys()).size).toBe(allHelpKeys().length);
	});

	it("has every workspace help key in all shipped locales", () => {
		for (const [locale, dict] of Object.entries(LOCALES)) {
			const missing = allHelpKeys().filter((key) => readMessage(dict, key) === undefined);
			const empty = allHelpKeys().filter((key) => readMessage(dict, key)?.trim() === "");
			expect(missing, `${locale} missing keys: ${missing.join(", ")}`).toEqual([]);
			expect(empty, `${locale} empty keys: ${empty.join(", ")}`).toEqual([]);
		}
	});

	it("keeps Thai translated and id/ms intentionally English for this help slice", () => {
		for (const key of allHelpKeys()) {
			expect(readMessage(th as Dict, key), `${key} should contain Thai copy`).toMatch(/[\u0E00-\u0E7F]/);
			expect(readMessage(id as Dict, key), `id ${key} should use English copy`).toBe(readMessage(en as Dict, key));
			expect(readMessage(ms as Dict, key), `ms ${key} should use English copy`).toBe(readMessage(en as Dict, key));
		}
	});

	it("resolves key maps into display copy without leaking raw keys", () => {
		const dashboard = resolveWorkspaceHelpTopic("dashboard", translatorFor(en as Dict));
		expect(dashboard).toEqual({
			title: "Dashboard",
			oneLiner: "Start here to see priority work, project health, and the next chapter to open.",
			steps: [
				"Check the Today card for the most important chapter or task.",
				"Use priority and assigned-work rails to jump into work that needs a decision.",
				"Open Library when you need to switch titles, chapters, or target languages.",
			],
		});

		const all = resolveWorkspaceHelpTopics(translatorFor(en as Dict));
		expect(Object.keys(all)).toEqual(REQUIRED_TOPICS);
		for (const topic of Object.values(all)) {
			expect(topic.title.startsWith("workspaceHelp.")).toBe(false);
			expect(topic.oneLiner.startsWith("workspaceHelp.")).toBe(false);
			expect(topic.steps).toHaveLength(3);
			expect(topic.steps.some((step) => step.startsWith("workspaceHelp."))).toBe(false);
		}
	});

	it("maps only concrete workspace views to help topics", () => {
		expect(getWorkspaceHelpTopicIdForView("dashboard")).toBe("dashboard");
		expect(getWorkspaceHelpTopicIdForView("library")).toBe("library");
		expect(getWorkspaceHelpTopicIdForView("work")).toBe("workboard");
		expect(getWorkspaceHelpTopicIdForView("reports")).toBe("reports");
		expect(getWorkspaceHelpTopicIdForView("settings")).toBe("settings");
		expect(getWorkspaceHelpTopicIdForView("pages")).toBeNull();
		expect(getWorkspaceHelpTopicIdForView("import")).toBeNull();
		expect(getWorkspaceHelpTopicIdForView("editor")).toBeNull();
	});
});
