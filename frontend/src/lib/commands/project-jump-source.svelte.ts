// Cross-project / cross-chapter jump source for the Cmd-K palette.
//
// The palette's original "open project/chapter" source was just
// `projectStore.recentProjects.slice(0, 8)` — current workspace, recent-only,
// capped at eight. That is fine as a most-recent shortcut but is NOT a true
// "jump to anything" source: a project you opened a month ago, or a chapter you
// have never touched in this session, simply isn't reachable from Cmd-K.
//
// This module builds palette rows from the FULL project listing (every project
// the signed-in user can see, each carrying its own chapter metadata — in this
// data model a "project" IS a chapter under a series `storyId`/`storyTitle`).
// It is intentionally split out of `workspace-commands.ts` AND out of
// `project.svelte.ts` (which is serialized against other in-flight work): the
// pure builder takes an already-fetched `ProjectSummary[]`, and a tiny async
// loader owns the lazy fetch + in-memory cache so the component can stay mostly
// synchronous and only await when the listing isn't ready yet.

import type { Command } from "$lib/commands/command-registry.ts";
import type { ProjectSummary } from "$lib/api/client.ts";
import * as api from "$lib/api/client.ts";
import {
	formatRecentProjectName,
	getShortProjectId,
} from "$lib/project/recent-projects.ts";

/** Translator shape shared with `workspace-commands.ts`. */
export type JumpTranslator = (key: string, fallback: string) => string;

export interface ProjectJumpSourceContext {
	/** Localised label resolver. Defaults to the Thai fallbacks so the pure
	 *  module is usable in tests without booting svelte-i18n. */
	t?: JumpTranslator;
	/** Project that is currently open; its jump row is skipped (you can't jump to
	 *  where you already are). */
	currentProjectId?: string | null;
	/** Navigate to a project/chapter. Injected so this module never imports the
	 *  editor UI store or SvelteKit navigation — the host wires the real handler
	 *  (which mirrors the recent-project picker: editor when the chapter has
	 *  pages, library otherwise). */
	onJump: (projectId: string) => void | Promise<void>;
	/** Cap on the number of jump rows emitted. The palette's own fuzzy filter
	 *  narrows further; this only bounds the worst-case unfiltered list size. */
	limit?: number;
}

const identityTranslator: JumpTranslator = (_key, fallback) => fallback;

/** Default ceiling on emitted rows. Generous (the recent-only source capped at
 *  8) but bounded so an enormous workspace can't flood the unfiltered palette. */
export const PROJECT_JUMP_LIMIT = 50;

/**
 * Compact, human label for the series a chapter belongs to. Falls back through
 * the project name (already audit-name-sanitised by `formatRecentProjectName`)
 * so internal/demo seeds never render as fabricated series titles.
 */
function storyLabel(summary: ProjectSummary): string {
	const title = summary.storyTitle?.trim();
	if (title) return title;
	return formatRecentProjectName(summary);
}

/** Chapter sub-label: prefer the explicit label, then the chapter title, then a
 *  "Chapter {n}" composed from the number, then the (sanitised) project name. */
function chapterLabel(summary: ProjectSummary, t: JumpTranslator): string {
	const label = summary.chapterLabel?.trim();
	if (label) return label;
	const chapterTitle = summary.chapterTitle?.trim();
	if (chapterTitle) return chapterTitle;
	const number = summary.chapterNumber?.trim();
	if (number) return `${t("commandPalette.jumpChapterWord", "ตอน")} ${number}`;
	return formatRecentProjectName(summary);
}

/**
 * Build the subtitle shown under a jump row: chapter · LANG · page-count, with
 * empties dropped so a bare chapter doesn't render dangling separators.
 */
function jumpSubtitle(summary: ProjectSummary, t: JumpTranslator): string | undefined {
	const parts = [
		chapterLabel(summary, t),
		summary.targetLang?.trim().toUpperCase() || undefined,
		summary.pageCount > 0
			? `${summary.pageCount} ${t("commandPalette.jumpPagesWord", "หน้า")}`
			: undefined,
	].filter(Boolean) as string[];
	return parts.length ? parts.join(" · ") : undefined;
}

/**
 * Searchable keyword bag for a jump row. Folds in series + chapter + language +
 * the short project id and broad English/Thai aliases so fuzzy matching hits
 * "open", "jump", "go to", "chapter" and the actual content the user remembers.
 */
function jumpKeywords(summary: ProjectSummary): string[] {
	return [
		"open",
		"jump",
		"go to",
		"goto",
		"project",
		"chapter",
		"series",
		"story",
		"เปิด",
		"ไป",
		"กระโดด",
		"เรื่อง",
		"ตอน",
		storyLabel(summary),
		summary.storyTitle ?? "",
		summary.chapterLabel ?? "",
		summary.chapterTitle ?? "",
		summary.chapterNumber ?? "",
		summary.name ?? "",
		summary.targetLang ?? "",
		getShortProjectId(summary.projectId),
	].filter(Boolean);
}

/**
 * Pure builder: turn a project listing into palette jump commands. Each row
 * jumps to one project/chapter from anywhere (any workspace surface, any
 * editor state). The currently open project is skipped. Deterministic and
 * dependency-light so it is trivially unit-testable.
 */
export function buildProjectJumpCommands(
	projects: readonly ProjectSummary[],
	context: ProjectJumpSourceContext,
): Command[] {
	const t = context.t ?? identityTranslator;
	const limit = Math.max(1, Math.floor(context.limit ?? PROJECT_JUMP_LIMIT));
	const prefix = t("commandPalette.openProjectPrefix", "เปิด");

	const commands: Command[] = [];
	for (const summary of projects) {
		if (commands.length >= limit) break;
		if (summary.projectId === context.currentProjectId) continue;
		commands.push({
			id: `jump-project-${summary.projectId}`,
			title: `${prefix} ${storyLabel(summary)}`,
			subtitle: jumpSubtitle(summary, t),
			section: "navigate",
			keywords: jumpKeywords(summary),
			run: () => {
				void context.onJump(summary.projectId);
			},
		});
	}
	return commands;
}

type LoadStatus = "idle" | "loading" | "ready" | "error";

/**
 * Lazy, cached loader for the full project listing. Owns a single in-flight
 * request (so a rapid re-open of the palette doesn't fan out duplicate fetches)
 * and an in-memory snapshot the synchronous command builder can read.
 *
 * Deliberately NOT a Svelte store and NOT part of `project.svelte.ts`: the
 * palette is the only consumer, the data is read-once-per-open, and keeping it
 * here avoids touching the serialized project store.
 */
class ProjectJumpStore {
	projects = $state<ProjectSummary[]>([]);
	status = $state<LoadStatus>("idle");
	error = $state<string | null>(null);

	private request: Promise<ProjectSummary[]> | null = null;

	/** True once a listing has been fetched at least once this session. */
	get loaded(): boolean {
		return this.status === "ready" || this.status === "error";
	}

	/**
	 * Fetch the listing if it hasn't been loaded yet (or a prior load errored).
	 * Resolves to the projects either way. Concurrent callers share one request.
	 * `force` re-fetches even when a snapshot already exists.
	 */
	async ensureLoaded(options: { force?: boolean } = {}): Promise<ProjectSummary[]> {
		if (!options.force && this.status === "ready") return this.projects;
		if (this.request) return this.request;
		this.status = "loading";
		this.error = null;
		this.request = api
			.listProjects()
			.then(({ projects }) => {
				this.projects = projects;
				this.status = "ready";
				return projects;
			})
			.catch((error: unknown) => {
				this.status = "error";
				this.error = error instanceof Error ? error.message : "โหลดรายการเรื่อง/ตอนไม่สำเร็จ";
				// Surface an empty list to callers; the palette renders an honest
				// loading/empty state rather than throwing inside the open path.
				return [] as ProjectSummary[];
			})
			.finally(() => {
				this.request = null;
			});
		return this.request;
	}

	/** Drop the cached listing so the next open re-fetches (e.g. after sign-out
	 *  or a workspace switch). */
	reset(): void {
		this.projects = [];
		this.status = "idle";
		this.error = null;
		this.request = null;
	}
}

export const projectJumpStore = new ProjectJumpStore();
