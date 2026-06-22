import type { WorkspaceProjectBrowserGroup } from "$lib/project/workspace-dashboard.js";
import { findStoryGroupByTitleKey } from "$lib/project/story-id.js";

/**
 * Turn a story/title key like "glass-harbor" into a readable label "Glass
 * Harbor". When there is no key at all, return `emptyLabel` (the localized
 * "Comic Library" the caller passes); the default stays Thai so TH and any
 * caller that doesn't pass a label is unchanged.
 */
export function titleFallback(value: string | null | undefined, emptyLabel = "คลังการ์ตูน"): string {
	if (!value) return emptyLabel;
	return value
		.split(/[-_]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/**
 * Resolve a story's display title from the project browser groups by its
 * `[titleKey]` URL segment. Matches by the stable story id (with legacy
 * full-segment fallback) so a renamed slug or an old bookmark still resolves.
 */
export function resolveStoryTitle(
	groups: WorkspaceProjectBrowserGroup[],
	titleKey: string | null | undefined,
): string | null {
	if (!titleKey) return null;
	return findStoryGroupByTitleKey(groups, (group) => group.storyId, titleKey)?.title ?? null;
}

/** Resolve a chapter's display label (e.g. "ตอน 12") from the groups by its project id. */
export function resolveChapterLabel(
	groups: WorkspaceProjectBrowserGroup[],
	projectId: string | null | undefined,
	titleKey: string | null | undefined,
): string | null {
	if (!projectId) return null;
	const scoped = findStoryGroupByTitleKey(groups, (group) => group.storyId, titleKey) ?? null;
	const chapter = (scoped?.chapters ?? groups.flatMap((group) => group.chapters)).find(
		(candidate) => candidate.project.projectId === projectId,
	);
	return chapter?.chapterLabel ?? null;
}
