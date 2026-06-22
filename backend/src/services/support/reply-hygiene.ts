// AI-support — reply hygiene: language detection + internal-reasoning stripping.
//
// Two leak/quality fixes a real-browser QA sweep found on the gpt-5.5 support
// agent's customer-visible reply:
//
//   (a) the reply included the model's INTERNAL TRIAGE REASONING (chain-of-thought
//       / "Reasoning:" / "Triage:" notes) — the customer must see ONLY the final
//       answer. We both tighten the system prompt AND defensively strip any
//       reasoning block the model still emits inline, so internal notes can never
//       land in the customer-facing message even if the model ignores the prompt.
//
//   (b) the reply was in ENGLISH to a THAI customer. We detect the customer's
//       language from their own message (the most reliable signal — no schema
//       migration needed) and instruct the agent to answer in THAT language.
//
// Both functions are PURE so they are trivially unit-tested and reused.

/** A human-readable language name the model is instructed to answer in. */
export interface DetectedLanguage {
	/** BCP-47-ish code for logging/telemetry (best-effort). */
	code: string;
	/** Name the model understands in the answer-language instruction. */
	name: string;
}

const DEFAULT_LANGUAGE: DetectedLanguage = { code: "en", name: "English" };

// Script-range detectors, ordered by specificity. We classify by the DOMINANT
// non-Latin script in the customer's message: a CJK/Thai/etc. message is almost
// never English even when it also contains some ASCII (brand names, URLs, numbers).
const SCRIPT_RULES: Array<{ code: string; name: string; test: RegExp }> = [
	{ code: "th", name: "Thai", test: /[฀-๿]/ },
	{ code: "ja", name: "Japanese", test: /[぀-ゟ゠-ヿ]/ }, // hiragana/katakana
	{ code: "ko", name: "Korean", test: /[가-힣ᄀ-ᇿ㄰-㆏]/ },
	{ code: "zh", name: "Chinese", test: /[一-鿿㐀-䶿]/ }, // after ja so kana wins
	{ code: "ar", name: "Arabic", test: /[؀-ۿݐ-ݿ]/ },
	{ code: "he", name: "Hebrew", test: /[֐-׿]/ },
	{ code: "ru", name: "Russian", test: /[Ѐ-ӿ]/ },
	{ code: "hi", name: "Hindi", test: /[ऀ-ॿ]/ },
	{ code: "el", name: "Greek", test: /[Ͱ-Ͽ]/ },
];

/**
 * Detect the customer's language from their message text by dominant script.
 *
 * Returns English only when the text is (effectively) Latin-script — never as a
 * silent default for a non-Latin message. Empty/whitespace input falls back to the
 * provided default so the agent still has a language to answer in.
 */
export function detectCustomerLanguage(
	text: string | undefined | null,
	fallback: DetectedLanguage = DEFAULT_LANGUAGE,
): DetectedLanguage {
	const trimmed = (text ?? "").trim();
	if (!trimmed) return fallback;
	for (const rule of SCRIPT_RULES) {
		if (rule.test.test(trimmed)) return { code: rule.code, name: rule.name };
	}
	// Latin script (or no recognised non-Latin script) → English. We do NOT attempt
	// to distinguish Latin-script languages (es/fr/de/…) here; the model is told to
	// "answer in the customer's language" and a Latin-script message is the one case
	// where matching the customer's own words is the safest instruction anyway.
	return fallback;
}

/**
 * The per-conversation answer-language instruction injected as a system message.
 * Names the detected language explicitly so the model does not default to English.
 */
export function answerLanguageInstruction(language: DetectedLanguage): string {
	return [
		`The customer is writing in ${language.name}.`,
		`Write your ENTIRE reply to the customer in ${language.name}.`,
		`Do NOT answer in English unless the customer's own message is in English.`,
	].join(" ");
}

// ── Localized, customer-facing canned messages ────────────────────────────────
// These are posted to the customer DIRECTLY (not via the model) on two paths:
//   - safeHandoffMessage: when the model's cleaned reply is empty (reasoning-only
//     output, see stripInternalReasoning) — a generic "a specialist will follow up".
//   - routingNote: the escalation routing note appended to the customer message.
// Both MUST be in the customer's detected language (en/th/ja/ko/zh, with English as
// the fallback for any undetected/other language) — never hardcoded English.

const SUPPORTED_LOCALE_CODES = ["en", "th", "ja", "ko", "zh"] as const;
type SupportedLocale = (typeof SUPPORTED_LOCALE_CODES)[number];

function resolveLocale(language: DetectedLanguage): SupportedLocale {
	return (SUPPORTED_LOCALE_CODES as readonly string[]).includes(language.code)
		? (language.code as SupportedLocale)
		: "en";
}

// A safe generic handoff posted to the customer when there is NO usable model answer
// (e.g. the model returned only internal reasoning, which we strip to empty). It must
// reveal nothing about the internal triage — just that a human will follow up.
const HANDOFF_MESSAGES: Record<SupportedLocale, string> = {
	en: "Thanks for reaching out — a support specialist will follow up with you shortly.",
	th: "ขอบคุณที่ติดต่อเข้ามา ทีมงานฝ่ายสนับสนุนของเราจะติดต่อกลับหาคุณโดยเร็วที่สุด",
	ja: "お問い合わせありがとうございます。担当者より追ってご連絡いたします。",
	ko: "문의해 주셔서 감사합니다. 담당 상담원이 곧 연락드리겠습니다.",
	zh: "感谢您的联系，我们的支持专员会尽快与您跟进。",
};

/**
 * A safe, generic handoff message in the customer's language. Used when the model
 * produced no customer-usable reply (reasoning-only output stripped to empty) so we
 * never post an empty message or leak internal triage.
 */
export function safeHandoffMessage(language: DetectedLanguage = DEFAULT_LANGUAGE): string {
	return HANDOFF_MESSAGES[resolveLocale(language)];
}

// The escalation routing note, localized. `{team}` is substituted with a NEUTRAL,
// localized team label (never raw internal department jargon) so a Thai/JA/KO/ZH
// customer gets a fully-localized note. `withReason` appends a localized parenthetical
// when a (already-sanitized, non-empty) reason is available.
const ROUTING_NOTE: Record<SupportedLocale, { base: string; withReason: (reason: string) => string }> = {
	en: {
		base: "I've routed this to our {team} team, who will follow up with you.",
		withReason: (r) => `I've routed this to our {team} team, who will follow up with you. (${r})`,
	},
	th: {
		base: "เราได้ส่งเรื่องนี้ต่อให้ทีม{team}ของเรา ซึ่งจะติดต่อกลับหาคุณ",
		withReason: (r) => `เราได้ส่งเรื่องนี้ต่อให้ทีม{team}ของเรา ซึ่งจะติดต่อกลับหาคุณ (${r})`,
	},
	ja: {
		base: "この件は{team}チームに引き継ぎました。担当者より追ってご連絡いたします。",
		withReason: (r) => `この件は{team}チームに引き継ぎました。担当者より追ってご連絡いたします。（${r}）`,
	},
	ko: {
		base: "이 문의를 {team} 팀에 전달했으며, 담당자가 곧 연락드리겠습니다.",
		withReason: (r) => `이 문의를 {team} 팀에 전달했으며, 담당자가 곧 연락드리겠습니다. (${r})`,
	},
	zh: {
		base: "我已将此事转交给我们的{team}团队，他们会尽快与您跟进。",
		withReason: (r) => `我已将此事转交给我们的{team}团队，他们会尽快与您跟进。（${r}）`,
	},
};

// Neutral, localized team labels keyed by the internal department token. An unknown
// department falls back to a generic "support" label rather than leaking raw jargon.
const DEPARTMENT_LABELS: Record<string, Record<SupportedLocale, string>> = {
	billing: { en: "billing", th: "การเรียกเก็บเงิน", ja: "請求", ko: "결제", zh: "账单" },
	technical: { en: "technical support", th: "ฝ่ายเทคนิค", ja: "技術サポート", ko: "기술 지원", zh: "技术支持" },
	abuse: { en: "trust & safety", th: "ความปลอดภัยและความน่าเชื่อถือ", ja: "信頼と安全", ko: "신뢰 및 안전", zh: "信任与安全" },
	general: { en: "support", th: "ฝ่ายสนับสนุน", ja: "サポート", ko: "고객 지원", zh: "客户支持" },
};

const GENERIC_TEAM_LABEL: Record<SupportedLocale, string> = DEPARTMENT_LABELS.general!;

function departmentLabel(department: string | undefined, locale: SupportedLocale): string {
	const entry = department ? DEPARTMENT_LABELS[department] : undefined;
	return (entry ?? GENERIC_TEAM_LABEL)[locale];
}

/**
 * Build the customer-facing escalation routing note in the customer's language.
 *
 * - The team name is a NEUTRAL, localized label (never raw internal department jargon).
 * - `reason` is expected to be ALREADY sanitized (run through stripInternalReasoning by
 *   the caller). When it is empty/blank the parenthetical is omitted cleanly — important
 *   now that a reasoning-only reason strips to "".
 */
export function escalationRoutingNote(
	department: string | undefined,
	reason: string | undefined | null,
	language: DetectedLanguage = DEFAULT_LANGUAGE,
): string {
	const locale = resolveLocale(language);
	const team = departmentLabel(department, locale);
	const tmpl = ROUTING_NOTE[locale];
	const safeReason = (reason ?? "").trim();
	const note = safeReason ? tmpl.withReason(safeReason) : tmpl.base;
	return note.replace("{team}", team);
}

// ── Localized customer-facing NOTIFICATIONS (title + body) ─────────────────────
// `notifyRequester` (in ai-agent.ts) sends a notification to ticket.requesterUserId —
// i.e. the CUSTOMER. Its title/body were previously hardcoded English, so a Thai/JA/
// KO/ZH customer got an English notification even when the in-app ticket message was
// localized. These builders produce the title+body in the customer's detected language
// (en/th/ja/ko/zh, English fallback) and carry NO internal reasoning/triage/department
// jargon — the escalation notification uses the SAME neutral localized team label as the
// routing note and NEVER echoes the model's raw reason (that could leak triage into the
// notification feed). The notification is a "you have an update" nudge; the full sanitized
// answer/routing note lives in the in-app ticket message.

export interface LocalizedNotification {
	title: string;
	body: string;
}

const REPLY_NOTIFICATION: Record<SupportedLocale, LocalizedNotification> = {
	en: { title: "Support replied to your ticket", body: "Our assistant answered your request." },
	th: { title: "ฝ่ายสนับสนุนตอบกลับเรื่องของคุณแล้ว", body: "ผู้ช่วยของเราได้ตอบคำถามของคุณแล้ว" },
	ja: { title: "サポートからお問い合わせへの返信があります", body: "アシスタントがお問い合わせにお答えしました。" },
	ko: { title: "고객 지원팀이 문의에 답변했습니다", body: "상담 도우미가 문의에 답변해 드렸습니다." },
	zh: { title: "支持团队已回复您的工单", body: "我们的助手已回复您的请求。" },
};

/**
 * The customer-facing "your ticket was answered" notification, localized. Posted to the
 * requester (the customer) on the normal reply path. Never English-only.
 */
export function replyNotification(language: DetectedLanguage = DEFAULT_LANGUAGE): LocalizedNotification {
	return REPLY_NOTIFICATION[resolveLocale(language)];
}

// `{team}` is substituted with the SAME neutral localized department label used by the
// routing note, so the notification never leaks raw department jargon or the model's reason.
const ESCALATION_NOTIFICATION: Record<SupportedLocale, { title: string; body: string }> = {
	en: { title: "Your request was routed to our {team} team", body: "A teammate will follow up with you shortly." },
	th: { title: "เราได้ส่งเรื่องของคุณต่อให้ทีม{team}", body: "ทีมงานของเราจะติดต่อกลับหาคุณโดยเร็วที่สุด" },
	ja: { title: "お問い合わせを{team}チームに引き継ぎました", body: "担当者より追ってご連絡いたします。" },
	ko: { title: "문의를 {team} 팀에 전달했습니다", body: "담당자가 곧 연락드리겠습니다." },
	zh: { title: "我们已将您的请求转交给{team}团队", body: "我们的团队成员会尽快与您跟进。" },
};

/**
 * The customer-facing "routed to a team / a human will follow up" notification, localized.
 * Posted to the requester (the customer) on EVERY handoff/escalation path (admission,
 * provider-disabled, model-error, budget exhaustion, model escalation, reasoning-only
 * handoff). Uses a NEUTRAL localized team label; NEVER echoes the model's raw reason.
 */
export function escalationNotification(
	department: string | undefined,
	language: DetectedLanguage = DEFAULT_LANGUAGE,
): LocalizedNotification {
	const locale = resolveLocale(language);
	const team = departmentLabel(department, locale);
	const tmpl = ESCALATION_NOTIFICATION[locale];
	return { title: tmpl.title.replace("{team}", team), body: tmpl.body };
}

// Lines/blocks that mark INTERNAL reasoning or triage notes the model sometimes
// prepends. Matched at the START of a line, case-insensitive. We strip the label
// AND its content up to the next blank line / answer marker.
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

// Markers the model uses to delimit the customer-facing portion. Everything BEFORE
// the LAST such marker is treated as internal preamble and dropped.
const ANSWER_MARKERS = [
	"final answer",
	"final reply",
	"customer reply",
	"customer-facing reply",
	"reply to customer",
	"answer",
	"response",
];

function isReasoningLabelLine(line: string): boolean {
	// Labelled preamble: `Reasoning:` / `Internal note:` / markdown-quote/bullet
	// prefixed variants. Requires a colon.
	const m = line.match(/^\s*[#>*-]*\s*([a-z][a-z \-]*?)\s*[:：]/i);
	if (m) {
		const label = m[1]!.trim().toLowerCase();
		if (REASONING_LABELS.includes(label)) return true;
	}
	// Markdown HEADING form WITHOUT a colon: `## Internal reasoning`,
	// `### Triage`, `# Thoughts`, etc. The model sometimes emits its internal
	// triage under a markdown heading instead of a `Label:` preamble — that
	// heading + its section must be stripped just the same, or the reasoning
	// leaks to the customer (a16 #11). A heading is internal when its text STARTS
	// WITH a reasoning label (e.g. "Internal reasoning", "Triage notes").
	return isReasoningHeadingLine(line);
}

/**
 * True when a line is a markdown heading (`#`, `##`, …) whose title denotes
 * internal reasoning/triage — e.g. `## Internal reasoning`, `### Triage notes`,
 * `# Thoughts`. Matched by the heading title STARTING WITH a known reasoning
 * label so "Internal reasoning" / "Triage notes" both qualify while a legitimate
 * answer heading ("## How to reset your password") does not.
 */
function isReasoningHeadingLine(line: string): boolean {
	const m = line.match(/^\s*#{1,6}\s+(.+?)\s*[:：]?\s*$/);
	if (!m) return false;
	const title = m[1]!.trim().toLowerCase();
	return REASONING_LABELS.some(
		(label) => title === label || title.startsWith(`${label} `) || title.startsWith(`${label}:`),
	);
}

/** Any markdown heading line (`#`..`######`), used as a reasoning-block terminator. */
function isMarkdownHeadingLine(line: string): boolean {
	return /^\s*#{1,6}\s+\S/.test(line);
}

function answerMarkerPrefix(line: string): boolean {
	const m = line.match(/^\s*[#>*-]*\s*([a-z][a-z \-]*?)\s*[:：]\s*(.*)$/i);
	if (!m) return false;
	const label = m[1]!.trim().toLowerCase();
	return ANSWER_MARKERS.includes(label);
}

/**
 * Strip internal reasoning / triage notes from a model reply so ONLY the final
 * customer-facing answer remains.
 *
 * Handles three shapes the model produces in practice:
 *   1. A `<thinking>…</thinking>` / `<reasoning>…</reasoning>` block (any tag whose
 *      name is a reasoning label) — removed wholesale.
 *   2. A labelled preamble (`Reasoning: …`, `Triage: …`, `Internal note: …`) at the
 *      start, optionally followed by an explicit answer marker (`Final answer: …`).
 *      The preamble is dropped; the answer marker's label is stripped, keeping its
 *      content.
 *   3. Plain text with no markers — returned as-is (trimmed).
 *
 * REASONING-ONLY OUTPUT → EMPTY. If the model returned ONLY internal reasoning/triage
 * (nothing survives block-stripping), this returns "" — it must NEVER fall back to the
 * inline text after a reasoning label (that text IS internal reasoning) nor to the
 * original (which is the full reasoning). The callers detect the empty result and post
 * a safe localized handoff INSTEAD of leaking triage to the customer.
 *
 * It still NEVER blanks a reply that DID carry answer content: only a pure
 * reasoning-only message collapses to empty.
 */
export function stripInternalReasoning(reply: string | undefined | null): string {
	const original = (reply ?? "").trim();
	if (!original) return "";

	// (1) Remove fenced/tagged reasoning blocks: <thinking>…</thinking>, etc.
	let text = original;
	for (const label of REASONING_LABELS) {
		const tag = label.replace(/[ ]/g, "[ _-]?");
		const re = new RegExp(`<\\s*${tag}\\s*>[\\s\\S]*?<\\s*/\\s*${tag}\\s*>`, "gi");
		text = text.replace(re, "");
	}
	text = text.trim();

	// (2) If there is an explicit answer marker, keep everything AFTER the last one.
	const lines = text.split(/\r?\n/);
	let lastAnswerMarkerIdx = -1;
	for (let i = 0; i < lines.length; i += 1) {
		if (answerMarkerPrefix(lines[i]!)) lastAnswerMarkerIdx = i;
	}
	if (lastAnswerMarkerIdx >= 0) {
		const markerLine = lines[lastAnswerMarkerIdx]!;
		const m = markerLine.match(/^\s*[#>*-]*\s*[a-z][a-z \-]*?\s*[:：]\s*(.*)$/i);
		const inlineRest = (m?.[1] ?? "").trim();
		const after = lines.slice(lastAnswerMarkerIdx + 1).join("\n").trim();
		const answer = [inlineRest, after].filter(Boolean).join("\n").trim();
		// An explicit answer marker is the authoritative boundary: everything after the LAST
		// marker is the customer answer. When that is EMPTY (e.g. `Final answer:` with nothing
		// after it, the rest being internal reasoning ABOVE it), we must NOT fall through and
		// re-mine the reasoning preamble for "answer" text — that would leak triage. Return
		// EMPTY so the caller posts a safe handoff.
		//
		// CRITICAL (a16 re-review P1 #3): the post-marker content is NOT automatically
		// customer-safe. The model can append its own internal sections AFTER the marker,
		// e.g. `Final answer:\nHi\n\n## Internal reasoning\nsecret` or
		// `Final answer: Hi\nInternal: fraud flag`. Taking everything after the marker
		// verbatim would leak that internal block to the customer. So we STILL run the
		// internal-section/heading stripper over the post-marker answer — and in DEFAULT-
		// DENY mode: the marker already fixed the answer boundary, so ANY reasoning-labelled
		// block after it is internal and removed wherever it appears (not only at a
		// paragraph start). No internal-kind block can survive regardless of the marker.
		return stripReasoningSections(answer, { aggressiveLabels: true });
	}

	// (3) No answer marker: strip reasoning-labelled blocks + internal headings.
	return stripReasoningSections(text);
}

/**
 * Strip reasoning-labelled blocks + internal markdown-heading sections from a block
 * of text, returning ONLY the customer-facing prose. Shared by both the
 * answer-marker branch (run over the post-marker content so an internal section
 * appended AFTER `Final answer:` can never survive — a16 re-review P1 #3) and the
 * no-marker branch.
 *
 * Drops leading reasoning-labelled blocks. A reasoning label consumes its line and
 * any following lines until a blank line or a non-label, non-continuation line that
 * looks like prose. CONSECUTIVE reasoning labels (each on its own unindented line,
 * e.g. `Reasoning: …` then `Triage: …` then `Internal: …`) must ALL be consumed —
 * when a reasoning block ends on a non-continuation line we RE-CHECK that line: if
 * it is itself a reasoning label it starts a new reasoning block; only a genuine
 * non-label line begins the answer.
 *
 * A labelled reasoning block (`Internal:`/`Reasoning:`/`Triage:` …) is stripped
 * while still in the preamble AND — crucially for the post-marker path — whenever it
 * starts a NEW PARAGRAPH (preceded by a blank line / at the very top), even AFTER
 * answer content. This default-denies an internal block the model APPENDS after the
 * customer answer (e.g. `Final answer:\nHi\n\nInternal: fraud flag`) without
 * truncating a legit answer that merely contains an inline `Note:`-style line mid-
 * paragraph. A reasoning markdown HEADING (`## Internal reasoning`) is ALWAYS
 * stripped — including after answer content — as a full section.
 *
 * `opts.aggressiveLabels` (used on the post-`Final answer:` path) strips a
 * reasoning-labelled block wherever it appears — not only in the preamble / at a
 * paragraph start — because the marker has already fixed the answer boundary, so any
 * later internal-kind label is internal by definition (default-deny).
 *
 * Returns "" when nothing customer-facing survives (reasoning-only input) so the
 * caller can post a safe handoff instead of leaking triage.
 */
function stripReasoningSections(text: string, opts: { aggressiveLabels?: boolean } = {}): string {
	const aggressiveLabels = opts.aggressiveLabels === true;
	const lines = text.split(/\r?\n/);
	const out: string[] = [];
	let inReasoningBlock = false;
	// A reasoning block opened by a markdown HEADING (`## Internal reasoning`)
	// runs as a SECTION: its prose body is non-indented, so it must extend through
	// plain prose until the next markdown heading (or a reasoning label). A block
	// opened by a `Label:` preamble keeps the original prose-ends-the-block rule.
	let reasoningBlockIsHeading = false;
	let seenAnswerContent = false;
	// True at the start of a new paragraph: the very first line, or the line right
	// after a blank line. A labelled reasoning block at a paragraph boundary is
	// internal even after answer content (the model's appended `Internal:` note).
	let atParagraphStart = true;
	for (const line of lines) {
		if (inReasoningBlock) {
			if (reasoningBlockIsHeading) {
				// Heading section: only the NEXT markdown heading (re-checked below for
				// whether it is itself reasoning or the start of the answer) terminates
				// it. Everything in between — prose, blanks, bullets — is internal.
				if (!isMarkdownHeadingLine(line)) continue;
				inReasoningBlock = false;
				reasoningBlockIsHeading = false;
				// fall through to re-evaluate this heading line.
			} else {
				// Blank line ends the reasoning block (the next line is re-evaluated fresh).
				if (line.trim() === "") {
					inReasoningBlock = false;
					atParagraphStart = true;
					continue;
				}
				// Indented / bullet continuation stays part of the reasoning block.
				if (/^\s+/.test(line) || /^\s*[-*>]/.test(line)) continue;
				// Otherwise the block ends here — but RE-CHECK this line below (it may be the
				// next consecutive reasoning label, not answer content).
				inReasoningBlock = false;
			}
		}
		// An unindented reasoning label starts/continues a reasoning block and is
		// dropped: in the preamble (before any answer content) OR at any paragraph
		// boundary (so an internal block APPENDED after the answer is also caught). A
		// reasoning markdown heading can appear even AFTER answer content (the model
		// sometimes appends `## Internal notes` at the END), so heading-form reasoning
		// is always stripped, not only in the preamble.
		const headingReasoning = isReasoningHeadingLine(line);
		const labelStrippable = aggressiveLabels || !seenAnswerContent || atParagraphStart;
		if (headingReasoning || (labelStrippable && isReasoningLabelLine(line))) {
			inReasoningBlock = true;
			reasoningBlockIsHeading = headingReasoning;
			continue;
		}
		const isBlank = line.trim() === "";
		if (!isBlank) seenAnswerContent = true;
		atParagraphStart = isBlank;
		out.push(line);
	}
	const stripped = out.join("\n").trim();
	if (stripped) return stripped;
	// REASONING-ONLY OUTPUT: nothing survived block-stripping — the model returned ONLY
	// internal reasoning/triage. Return EMPTY. We must NOT fall back to the inline text
	// after the reasoning label (that text IS the reasoning, e.g. `Reasoning: customer is
	// a churn risk` → `customer is a churn risk`) NOR to the original (the full reasoning).
	// The callers turn an empty cleaned reply into a safe localized handoff, so internal
	// triage can never reach the customer.
	return "";
}
