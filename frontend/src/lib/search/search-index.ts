// Global-search index + ranking.
//
// Pure, dependency-light helpers that turn the user's already-loaded workspace
// data (recent projects/chapters + the workspaces they belong to) into a flat,
// searchable result list and rank it against a query. No Svelte/runtime imports
// so it stays trivially testable and reusable; the SearchModal component wires
// the live stores and navigation.
//
// We deliberately search CLIENT-SIDE over data the app has already fetched
// (`projectStore.recentProjects`, `workspacesStore.workspaces`) rather than
// adding a backend search endpoint: the prototype's working set fits in memory,
// substring/fuzzy ranking over a few dozen rows is instant, and it avoids a
// network round-trip on every keystroke. A backend index can layer in later if
// the working set outgrows what the client already holds.

import { fuzzyScore } from "$lib/commands/command-registry.ts";
import type { ProjectSummary, WorkspaceRecord } from "$lib/api/client.js";

export type SearchResultKind = "chapter" | "workspace";

export interface SearchResult {
	/** Stable id (used as the keyed-each key and the active-descendant target). */
	id: string;
	kind: SearchResultKind;
	/** Primary line (story / chapter / workspace name). */
	title: string;
	/** Secondary line (chapter label · language · page count, or plan). */
	subtitle?: string;
	/** Short kind badge ("Chapter" / "Workspace"), localised by the caller. */
	badge: string;
	/** The id needed to act on this result (projectId or workspaceId). */
	targetId: string;
	/** Hidden terms folded into matching (aliases, language codes, etc.). */
	keywords: string[];
}

export interface SearchResultMatch {
	result: SearchResult;
	score: number;
}

/** Labels the caller localises; defaults keep the module usable without i18n. */
export interface SearchIndexLabels {
	chapter: string;
	workspace: string;
	/** Prefix for a chapter NUMBER when no explicit label exists (e.g. "Ch."). */
	chapterNumberPrefix: string;
}

const DEFAULT_LABELS: SearchIndexLabels = {
	chapter: "Chapter",
	workspace: "Workspace",
	chapterNumberPrefix: "Ch.",
};

/**
 * Resolve a human chapter label so a result can always say WHICH chapter it is
 * (issue #9a): an explicit label, else the chapter number prefixed (e.g.
 * "Ch. 5" / "ตอนที่ 5"), else nothing.
 */
function resolveChapterLabel(summary: ProjectSummary, prefix: string): string | undefined {
	const explicit = summary.chapterLabel?.trim();
	if (explicit) return explicit;
	const number = summary.chapterNumber?.trim();
	if (number) return prefix.trim() ? `${prefix.trim()} ${number}` : number;
	return undefined;
}

/** Drop falsy/blank parts and join with the workspace dot separator. */
function joinParts(parts: Array<string | undefined | null>): string | undefined {
	const kept = parts.map((p) => p?.toString().trim()).filter((p): p is string => Boolean(p));
	return kept.length ? kept.join(" · ") : undefined;
}

/**
 * Build the chapter title shown in a result. A `ProjectSummary` is one chapter
 * of a story, so prefer "Story — Chapter" when both exist, falling back through
 * the chapter label / project name so a result is never blank.
 */
function chapterTitle(summary: ProjectSummary, chapterLabel: string | undefined): string {
	const story = summary.storyTitle?.trim();
	const chapter = summary.chapterTitle?.trim() || chapterLabel;
	if (story && chapter) return `${story} — ${chapter}`;
	return story || chapter || summary.name;
}

function chapterSubtitle(summary: ProjectSummary, chapterLabel: string | undefined): string | undefined {
	const lang = summary.targetLang ? summary.targetLang.toUpperCase() : undefined;
	const pages = summary.pageCount ? `${summary.pageCount}p` : undefined;
	// Always surface the chapter label (e.g. "Ch. 5" / "ตอนที่ 5") so a result
	// tells the user WHICH chapter it is (issue #9a) — the title shows the story
	// and/or chapter *title*, which isn't enough to disambiguate same-titled or
	// untitled chapters. Skip it only when the title already fell back to the same
	// chapter label (no chapter title), which would otherwise duplicate it.
	const titleEndsWithLabel = !summary.chapterTitle?.trim() && Boolean(chapterLabel);
	return joinParts([titleEndsWithLabel ? undefined : chapterLabel, lang, pages]);
}

/**
 * Flatten loaded workspace data into searchable results. Chapters come first
 * (the primary thing users jump to); workspaces follow. Pass `currentWorkspaceId`
 * to drop the active workspace from the "switch workspace" results (jumping to
 * the one you're already in is a no-op).
 */
export function buildSearchIndex(input: {
	projects: ProjectSummary[];
	workspaces: WorkspaceRecord[];
	currentWorkspaceId?: string | null;
	labels?: Partial<SearchIndexLabels>;
}): SearchResult[] {
	const labels = { ...DEFAULT_LABELS, ...input.labels };
	const results: SearchResult[] = [];

	for (const summary of input.projects) {
		const chapterLabel = resolveChapterLabel(summary, labels.chapterNumberPrefix);
		results.push({
			id: `chapter:${summary.projectId}`,
			kind: "chapter",
			title: chapterTitle(summary, chapterLabel),
			subtitle: chapterSubtitle(summary, chapterLabel),
			badge: labels.chapter,
			targetId: summary.projectId,
			keywords: [
				summary.name,
				summary.storyTitle ?? "",
				summary.chapterTitle ?? "",
				summary.chapterLabel ?? "",
				summary.chapterNumber ?? "",
				summary.targetLang ?? "",
				summary.sourceLang ?? "",
			].filter(Boolean),
		});
	}

	for (const workspace of input.workspaces) {
		if (workspace.workspaceId === input.currentWorkspaceId) continue;
		results.push({
			id: `workspace:${workspace.workspaceId}`,
			kind: "workspace",
			title: workspace.name,
			subtitle: workspace.planId ? workspace.planId.toUpperCase() : undefined,
			badge: labels.workspace,
			targetId: workspace.workspaceId,
			keywords: [workspace.name, workspace.planId ?? ""].filter(Boolean),
		});
	}

	return results;
}

function resultHaystack(result: SearchResult): string {
	return [result.title, result.subtitle ?? "", ...result.keywords].join(" ");
}

/**
 * Rank `results` against `query`. An empty query returns the full list in its
 * original order (chapters first), capped to `limit` so the modal opens with a
 * useful "recent" set. A non-empty query drops non-matches and sorts by score,
 * with index as a stable tiebreak.
 */
export function searchResults(
	results: SearchResult[],
	query: string,
	limit = 20,
): SearchResultMatch[] {
	const q = query.trim();
	if (!q) {
		return results.slice(0, limit).map((result) => ({ result, score: 0 }));
	}

	const matches: Array<SearchResultMatch & { index: number }> = [];
	for (let index = 0; index < results.length; index += 1) {
		const result = results[index];
		const score = fuzzyScore(q, resultHaystack(result));
		if (score === null) continue;
		matches.push({ result, score, index });
	}

	matches.sort((a, b) => b.score - a.score || a.index - b.index);
	return matches.slice(0, limit).map(({ result, score }) => ({ result, score }));
}
