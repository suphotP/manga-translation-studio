import type { PageWorkSummary } from "$lib/project/page-work-summary.js";
import { pageNeedsAttention } from "$lib/project/page-work-summary.js";

export type ChapterQueueFilter = "all" | "attention" | "blocked" | "review" | "tasks" | "ready";

export interface ChapterQueueStats {
	totalPages: number;
	attentionPages: number;
	readyPages: number;
	blockedPages: number;
	reviewPages: number;
	taskPages: number;
	duePages: number;
	overduePages: number;
	openTasks: number;
	openComments: number;
	aiAttention: number;
}

export function getChapterQueueStats(summaries: readonly PageWorkSummary[]): ChapterQueueStats {
	return summaries.reduce<ChapterQueueStats>((stats, summary) => ({
		totalPages: stats.totalPages + 1,
		attentionPages: stats.attentionPages + (pageNeedsAttention(summary) ? 1 : 0),
		readyPages: stats.readyPages + (summary.exportReady ? 1 : 0),
		blockedPages: stats.blockedPages + (summary.status === "blocked" ? 1 : 0),
		reviewPages: stats.reviewPages + (summary.status === "review" ? 1 : 0),
		taskPages: stats.taskPages + (summary.taskOpenCount > 0 ? 1 : 0),
		duePages: stats.duePages + (summary.dueTaskCount > 0 ? 1 : 0),
		overduePages: stats.overduePages + (summary.overdueTaskCount > 0 ? 1 : 0),
		openTasks: stats.openTasks + summary.taskOpenCount,
		openComments: stats.openComments + summary.openCommentCount,
		aiAttention: stats.aiAttention + summary.aiAttentionCount,
	}), {
		totalPages: 0,
		attentionPages: 0,
		readyPages: 0,
		blockedPages: 0,
		reviewPages: 0,
		taskPages: 0,
		duePages: 0,
		overduePages: 0,
		openTasks: 0,
		openComments: 0,
		aiAttention: 0,
	});
}

/**
 * Richer "attention" test for the chapter queue cards. This is intentionally a
 * superset of {@link pageNeedsAttention} (`status !== "ready"`): it also surfaces
 * any page that still carries an open production signal — open notes, open/overdue
 * tasks, AI/QC findings, or remaining export blockers — even if its coarse status
 * has settled. The queue uses THIS predicate (not the coarse one) so the "ต้องเช็ก"
 * filter shows everything a creator still has to clear before export.
 */
export function pageNeedsChapterQueueAttention(summary: PageWorkSummary): boolean {
	return summary.status === "blocked"
		|| summary.status === "review"
		|| summary.openCommentCount > 0
		|| summary.taskOpenCount > 0
		|| summary.overdueTaskCount > 0
		|| summary.aiAttentionCount > 0
		|| summary.qcErrorCount > 0
		|| summary.qcWarningCount > 0
		|| summary.exportBlockers.length > 0;
}

/**
 * Declarative predicate for a single chapter-queue filter tab. Centralizes the
 * per-filter rule so the component, stats, and tests share one source of truth.
 */
export function pageMatchesChapterQueueFilter(summary: PageWorkSummary, filter: ChapterQueueFilter): boolean {
	switch (filter) {
		case "all":
			return true;
		case "attention":
			return pageNeedsChapterQueueAttention(summary);
		case "blocked":
			return summary.status === "blocked";
		case "review":
			return summary.status === "review";
		case "tasks":
			return summary.taskOpenCount > 0;
		case "ready":
			return summary.exportReady;
		default:
			return true;
	}
}

/**
 * Declarative spec describing the full chapter-queue view: which filter tab is
 * active plus the free-text search query. Pass it to {@link selectChapterQueuePages}
 * to derive the visible page set reactively.
 */
export interface ChapterQueueViewSpec {
	filter: ChapterQueueFilter;
	search: string;
	/**
	 * Locale-dependent extra search tokens for a summary (e.g. the LOCALIZED status
	 * and next-action text the queue actually renders). The base haystack carries
	 * the raw producer codes ("Review"), but the user types what they SEE — the
	 * caller (a component with access to `$_`) supplies the visible strings here
	 * since this module is framework-agnostic and cannot localize itself.
	 */
	searchExtras?: (summary: PageWorkSummary) => string;
}

export interface ChapterQueueSelection {
	/** Pages that pass the active filter tab (search ignored). */
	filtered: PageWorkSummary[];
	/** Pages that pass BOTH the active filter tab and the search query. */
	visible: PageWorkSummary[];
}

export function filterChapterQueuePages(
	summaries: readonly PageWorkSummary[],
	filter: ChapterQueueFilter,
): PageWorkSummary[] {
	return summaries.filter((summary) => pageMatchesChapterQueueFilter(summary, filter));
}

export function pageMatchesChapterQueueSearch(
	summary: PageWorkSummary,
	query: string,
	searchExtras?: (summary: PageWorkSummary) => string,
): boolean {
	const normalizedQuery = normalizeChapterQueueSearch(query);
	if (!normalizedQuery) return true;
	// Substring match against the full joined search text (same semantics the
	// previous DOM filter used against `data-queue-search-text`), so a query that
	// spans token boundaries still matches exactly as it did before. The caller's
	// locale-dependent extras (visible status/next-action text) are appended so
	// what the user SEES stays searchable in every locale.
	const haystack = searchExtras
		? `${chapterQueueSearchText(summary)} ${normalizeChapterQueueSearch(searchExtras(summary))}`
		: chapterQueueSearchText(summary);
	return haystack.includes(normalizedQuery);
}

export function searchChapterQueuePages(
	summaries: readonly PageWorkSummary[],
	query: string,
	searchExtras?: (summary: PageWorkSummary) => string,
): PageWorkSummary[] {
	const normalizedQuery = normalizeChapterQueueSearch(query);
	if (!normalizedQuery) return [...summaries];
	return summaries.filter((summary) => pageMatchesChapterQueueSearch(summary, normalizedQuery, searchExtras));
}

/**
 * Single declarative entry point that derives the chapter-queue view from a spec.
 * `filtered` preserves source order after the filter tab; `visible` additionally
 * applies the search query. Replaces the old imperative DOM toggling.
 */
export function selectChapterQueuePages(
	summaries: readonly PageWorkSummary[],
	spec: ChapterQueueViewSpec,
): ChapterQueueSelection {
	const filtered = filterChapterQueuePages(summaries, spec.filter);
	const visible = searchChapterQueuePages(filtered, spec.search, spec.searchExtras);
	return { filtered, visible };
}

export function getChapterQueueLeadPage(summaries: readonly PageWorkSummary[]): PageWorkSummary | null {
	return summaries.find((summary) => summary.status === "blocked")
		?? summaries.find((summary) => summary.overdueTaskCount > 0)
		?? summaries.find((summary) => summary.openCommentCount > 0)
		?? summaries.find((summary) => summary.taskOpenCount > 0)
		?? summaries.find(pageNeedsAttention)
		?? summaries[0]
		?? null;
}

/** One production signal on a queue card: a stable `code` plus its `count`. */
export interface ChapterQueueSignal {
	code: "overdue" | "ai" | "comments" | "open" | "qc";
	count: number;
}

/**
 * Structured production signals for a queue card, in display order. Returns an
 * empty array when the page has no blockers (the consumer renders the localized
 * "no blockers" copy via `$_("chapterQueueSignal.none")`). Replaces the old
 * Thai-string `formatChapterQueueSignalLabel`.
 */
export function chapterQueueSignals(summary: PageWorkSummary): ChapterQueueSignal[] {
	const signals: ChapterQueueSignal[] = [];
	if (summary.overdueTaskCount > 0) signals.push({ code: "overdue", count: summary.overdueTaskCount });
	if (summary.aiAttentionCount > 0) signals.push({ code: "ai", count: summary.aiAttentionCount });
	if (summary.openCommentCount > 0) signals.push({ code: "comments", count: summary.openCommentCount });
	if (summary.taskOpenCount > 0) signals.push({ code: "open", count: summary.taskOpenCount });
	const qcCount = summary.qcErrorCount + summary.qcWarningCount;
	if (qcCount > 0) signals.push({ code: "qc", count: qcCount });
	return signals;
}

/**
 * One formatted assignee token. A `handle` (e.g. "@Mai", "QA") passes through
 * verbatim; a `code` ("you" | "solo") is localized by the consumer via
 * `$_("chapterQueueSignal.<code>")`.
 */
export type ChapterQueueAssignee = { handle: string } | { code: "you" | "solo" };

/**
 * Structured assignee tokens for a queue card (first two visible assignees).
 * Returns an empty array when nobody is assigned, so the consumer can render the
 * localized "no assignee" copy. Replaces the old Thai-string formatter.
 */
export function chapterQueueAssignees(assignees: readonly string[]): ChapterQueueAssignee[] {
	return assignees
		.map(formatChapterQueueAssignee)
		.filter((value): value is ChapterQueueAssignee => value !== null)
		.slice(0, 2);
}

function formatChapterQueueAssignee(value: string): ChapterQueueAssignee | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const normalized = trimmed.toLowerCase();
	if (normalized === "local-user") return { code: "you" };
	if (normalized === "solo") return { code: "solo" };
	if (normalized === "qa" || normalized === "qc") return { handle: normalized.toUpperCase() };
	if (trimmed.startsWith("@")) return { handle: trimmed };
	return { handle: `@${trimmed}` };
}

/**
 * The stable (locale-independent) assignee tokens used to build the search
 * haystack: real handles pass through, and the special codes contribute their
 * raw normalized handle ("local-user" / "solo") so a search for those still
 * matches regardless of the displayed locale.
 */
function chapterQueueAssigneeSearchTokens(assignees: readonly string[]): string[] {
	return assignees
		.map((value) => value.trim())
		.filter((value) => value.length > 0)
		.slice(0, 2);
}

/**
 * The full, normalized search haystack for one queue page. Built from STABLE,
 * locale-independent tokens so a query matches the underlying page data the same
 * way in every language: the page number forms (incl. the literal Thai `หน้า N`
 * a creator types), the page name, the raw status/next-action keys, the
 * primary-signal STABLE label code + its count (locale-independent now that the
 * signal carries a `labelCode`/`labelValues` instead of a pre-built Thai string),
 * the signal detail (dynamic page data), the priority label, the raw assignee
 * handles, and the export blockers. Returned pre-normalized for substring
 * matching in {@link pageMatchesChapterQueueSearch}.
 */
export function chapterQueueSearchText(summary: PageWorkSummary): string {
	const signal = summary.primarySignal;
	return normalizeChapterQueueSearch([
		String(summary.pageNumber),
		`p${summary.pageNumber}`,
		`หน้า ${summary.pageNumber}`,
		summary.name,
		summary.statusLabel,
		summary.nextAction,
		signal.labelCode,
		signal.labelValues ? String(signal.labelValues.n) : "",
		signal.detail,
		summary.priorityLabel,
		...chapterQueueAssigneeSearchTokens(summary.assignees),
		...summary.exportBlockers,
	].join(" "));
}

function normalizeChapterQueueSearch(value: string): string {
	return value
		.toLocaleLowerCase("th-TH")
		.replace(/\s+/g, " ")
		.trim();
}
