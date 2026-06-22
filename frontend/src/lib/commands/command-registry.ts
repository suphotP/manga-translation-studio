// Command palette action registry.
//
// A small, dependency-light catalog of workspace actions that the Cmd-K
// palette can search and run. Kept pure (no Svelte/runtime imports) so it is
// trivially testable and reusable. Each action carries searchable metadata
// (title, optional subtitle, keywords) plus a `run` callback.

export type CommandSection =
	| "navigate"
	| "create"
	| "tools"
	| "workspace"
	| "settings"
	| "account";

export interface Command {
	id: string;
	title: string;
	subtitle?: string;
	section: CommandSection;
	/** Extra terms folded into fuzzy matching (e.g. Thai + English aliases). */
	keywords?: string[];
	/** Optional shortcut hint shown on the right of the row. */
	shortcut?: string;
	run: () => void | Promise<void>;
}

export interface CommandMatch {
	command: Command;
	score: number;
}

/**
 * Stable display order for section headers. The builder appends commands in
 * roughly this order already, but pinning it here keeps headers grouped even if
 * a future caller registers out of order, and gives `searchCommands` a tiebreak
 * that survives score ties across sections.
 */
export const SECTION_ORDER: CommandSection[] = [
	"navigate",
	"create",
	"tools",
	"workspace",
	"settings",
	"account",
];

const SECTION_FALLBACK_LABELS: Record<CommandSection, string> = {
	navigate: "ไปยังหน้า",
	create: "สร้างใหม่",
	tools: "เครื่องมือ",
	workspace: "เวิร์กสเปซ",
	settings: "ตั้งค่า",
	account: "บัญชี",
};

/**
 * Resolve a human label for a section header. Pass an i18n resolver to localise
 * (the palette wires `$_`); without one we fall back to the Thai default so the
 * pure module stays usable in tests and non-Svelte contexts.
 */
export function sectionLabel(
	section: CommandSection,
	translate?: (section: CommandSection) => string | undefined,
): string {
	const localized = translate?.(section);
	if (localized) return localized;
	return SECTION_FALLBACK_LABELS[section] ?? section;
}

function sectionRank(section: CommandSection): number {
	const index = SECTION_ORDER.indexOf(section);
	return index === -1 ? SECTION_ORDER.length : index;
}

/**
 * Subsequence fuzzy match: every char of `query` must appear in `text` in
 * order. Returns a score (higher is better) or `null` for no match. Empty
 * queries match everything with a neutral score so the full list shows.
 */
export function fuzzyScore(query: string, text: string): number | null {
	const q = query.trim().toLowerCase();
	if (!q) return 0;
	const haystack = text.toLowerCase();

	let score = 0;
	let qi = 0;
	let lastMatch = -1;
	let streak = 0;

	for (let hi = 0; hi < haystack.length && qi < q.length; hi += 1) {
		if (haystack[hi] !== q[qi]) {
			streak = 0;
			continue;
		}
		// Reward adjacency (contiguous runs) and matches at word starts.
		streak += 1;
		score += streak * 2;
		if (hi === 0 || haystack[hi - 1] === " ") score += 5;
		if (lastMatch === hi - 1) score += 3;
		lastMatch = hi;
		qi += 1;
	}

	if (qi < q.length) return null;
	// Prefer shorter haystacks (tighter matches) and earlier first hits.
	score -= haystack.length * 0.05;
	return score;
}

function commandHaystack(command: Command): string {
	return [command.title, command.subtitle ?? "", ...(command.keywords ?? [])].join(" ");
}

/**
 * Rank `commands` against `query`. With an empty query the original order is
 * preserved (stable). Otherwise non-matching commands are dropped and the rest
 * sorted by descending score (ties keep registry order).
 */
export function searchCommands(commands: Command[], query: string): CommandMatch[] {
	const q = query.trim();
	if (!q) {
		return commands.map((command) => ({ command, score: 0 }));
	}

	const matches: Array<CommandMatch & { index: number }> = [];
	for (let index = 0; index < commands.length; index += 1) {
		const command = commands[index];
		const score = fuzzyScore(q, commandHaystack(command));
		if (score === null) continue;
		matches.push({ command, score, index });
	}

	// Keep sections grouped (Navigate before Create before …) even when filtering,
	// then rank by score within a section, with registry order as a stable
	// tiebreak. Grouping while typing matches Linear/VSCode and avoids headers
	// re-flowing on every keystroke.
	matches.sort((a, b) =>
		(sectionRank(a.command.section) - sectionRank(b.command.section))
		|| (b.score - a.score)
		|| (a.index - b.index),
	);
	return matches.map(({ command, score }) => ({ command, score }));
}
