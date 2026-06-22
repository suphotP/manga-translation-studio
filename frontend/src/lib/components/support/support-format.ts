// Customer support — shared formatting helpers.
//
// Small, dependency-free helpers used by the support ticket surfaces. Kept out
// of the components so the list/thread/atoms share one vocabulary and the
// formatting is unit-testable on its own.

import type { SupportMessageAuthorKind, SupportTicketCategory, SupportTicketStatus } from "$lib/api/client.ts";

/**
 * Translator shape these helpers accept. Mirrors the local `t(key, fallback)`
 * convention the Svelte surfaces wrap around svelte-i18n's `$_`. It is OPTIONAL
 * everywhere: when omitted (e.g. in unit tests, or any non-localised caller) the
 * helpers return the Thai source copy unchanged, so the app's default language
 * is preserved with zero behaviour change.
 */
export type SupportTranslate = (key: string, fallback: string) => string;

const identity: SupportTranslate = (_key, fallback) => fallback;

/** Human label for a ticket status (Thai-first, matching the app copy). */
export function statusLabel(status: SupportTicketStatus, t: SupportTranslate = identity): string {
	switch (status) {
		case "open":
			return t("support.status.open", "เปิดอยู่");
		case "pending":
			return t("support.status.pending", "รอตอบกลับ");
		case "escalated":
			return t("support.status.escalated", "ส่งต่อทีม");
		case "resolved":
			return t("support.status.resolved", "แก้ไขแล้ว");
		case "closed":
			return t("support.status.closed", "ปิดแล้ว");
	}
}

/** Human label for a ticket category. */
export function categoryLabel(category: SupportTicketCategory, t: SupportTranslate = identity): string {
	switch (category) {
		case "general":
			return t("support.category.general", "ทั่วไป");
		case "technical":
			return t("support.category.technical", "ทางเทคนิค");
		case "billing":
			return t("support.category.billing", "การเงิน/บิล");
		case "account":
			return t("support.category.account", "บัญชี");
		case "abuse":
			return t("support.category.abuse", "รายงานการใช้งานผิด");
	}
}

/** Sender label for a message author. */
export function authorLabel(kind: SupportMessageAuthorKind, t: SupportTranslate = identity): string {
	switch (kind) {
		case "customer":
			return t("support.author.customer", "คุณ");
		case "ai":
			return t("support.author.ai", "ผู้ช่วย AI");
		case "agent":
			return t("support.author.agent", "ทีมซัพพอร์ต");
		case "system":
			return t("support.author.system", "ระบบ");
	}
}

/** Whether a message was authored by the requester themselves (right-aligned). */
export function isOwnMessage(kind: SupportMessageAuthorKind): boolean {
	return kind === "customer";
}

// ── Customer-visibility guard (a16 #11 — defense in depth) ───────────────────
// The backend already (a) excludes internal-author-kind messages and (b)
// re-strips internal reasoning from AI replies before sending the customer
// thread. This is the RENDER-side belt-and-braces strip so internal triage /
// "## Internal reasoning" sections can NEVER reach the customer even if a stale
// API response or a future producer slips one through. Mirrors the backend
// reply-hygiene labels — kept intentionally small + dependency-free.

const REASONING_LABELS = [
	"reasoning",
	"chain of thought",
	"chain-of-thought",
	"thought",
	"thoughts",
	"thinking",
	"internal",
	"internal note",
	"internal notes",
	"triage",
	"triage notes",
	"analysis",
	"scratchpad",
];

function isReasoningLine(line: string): boolean {
	// `Label:` preamble form (optionally markdown-quote/bullet/heading prefixed).
	const labelled = line.match(/^\s*[#>*-]*\s*([a-z][a-z \-]*?)\s*[:：]/i);
	if (labelled) {
		const label = labelled[1]!.trim().toLowerCase();
		if (REASONING_LABELS.includes(label)) return true;
	}
	return isReasoningHeading(line);
}

function isReasoningHeading(line: string): boolean {
	const m = line.match(/^\s*#{1,6}\s+(.+?)\s*[:：]?\s*$/);
	if (!m) return false;
	const title = m[1]!.trim().toLowerCase();
	return REASONING_LABELS.some(
		(label) => title === label || title.startsWith(`${label} `) || title.startsWith(`${label}:`),
	);
}

function isMarkdownHeading(line: string): boolean {
	return /^\s*#{1,6}\s+\S/.test(line);
}

/**
 * Strip internal reasoning / triage sections from an AI message body. Removes
 * `<thinking>…</thinking>`-style tagged blocks, leading `Reasoning:`/`Triage:`
 * labelled preambles, and `## Internal reasoning` markdown-heading sections.
 * Mirrors the backend stripInternalReasoning so the customer never sees triage.
 */
export function stripInternalReasoning(body: string): string {
	let text = (body ?? "").trim();
	if (!text) return "";

	// (1) Tagged reasoning blocks: <thinking>…</thinking>, <reasoning>…</reasoning>, …
	for (const label of REASONING_LABELS) {
		const tag = label.replace(/ /g, "[ _-]?");
		text = text.replace(new RegExp(`<\\s*${tag}\\s*>[\\s\\S]*?<\\s*/\\s*${tag}\\s*>`, "gi"), "");
	}
	text = text.trim();

	// (2) Drop reasoning-labelled preambles + markdown reasoning-heading sections.
	const lines = text.split(/\r?\n/);
	const out: string[] = [];
	let inBlock = false;
	let blockIsHeading = false;
	let seenAnswer = false;
	for (const line of lines) {
		if (inBlock) {
			if (blockIsHeading) {
				if (!isMarkdownHeading(line)) continue;
				inBlock = false;
				blockIsHeading = false;
				// fall through: re-evaluate this heading line.
			} else {
				if (line.trim() === "") {
					inBlock = false;
					continue;
				}
				if (/^\s+/.test(line) || /^\s*[-*>]/.test(line)) continue;
				inBlock = false;
			}
		}
		const heading = isReasoningHeading(line);
		if (heading || (!seenAnswer && isReasoningLine(line))) {
			inBlock = true;
			blockIsHeading = heading;
			continue;
		}
		if (line.trim() !== "") seenAnswer = true;
		out.push(line);
	}
	return out.join("\n").trim();
}

/**
 * The body to RENDER for a message. AI messages are re-stripped of internal
 * reasoning (defense in depth, a16 #11); everything else renders verbatim.
 * Returns "" for an AI message that is reasoning-only — the caller should not
 * render an empty bubble.
 */
export function customerVisibleBody(kind: SupportMessageAuthorKind, body: string): string {
	if (kind === "ai") return stripInternalReasoning(body);
	return body;
}

/**
 * Absolute timestamp for tooltips / accessibility. Falls back to the raw string
 * if it cannot be parsed so we never render "Invalid Date".
 */
export function formatAbsolute(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleString("th-TH", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact relative time for list rows + message stamps. `now` is injectable so
 * the formatting is deterministic in tests. `t` is optional (see top of file):
 * without it the Thai source copy is returned unchanged.
 */
export function formatRelative(iso: string, now: number = Date.now(), t: SupportTranslate = identity): string {
	const date = new Date(iso);
	const time = date.getTime();
	if (Number.isNaN(time)) return iso;
	const diff = now - time;
	if (diff < MINUTE) return t("support.relative.justNow", "เมื่อสักครู่");
	if (diff < HOUR) {
		const count = Math.max(1, Math.round(diff / MINUTE));
		return t("support.relative.minutes", "{count} นาทีที่แล้ว").replace("{count}", String(count));
	}
	if (diff < DAY) {
		const count = Math.round(diff / HOUR);
		return t("support.relative.hours", "{count} ชม.ที่แล้ว").replace("{count}", String(count));
	}
	if (diff < 7 * DAY) {
		const count = Math.round(diff / DAY);
		return t("support.relative.days", "{count} วันที่แล้ว").replace("{count}", String(count));
	}
	return formatAbsolute(iso);
}
