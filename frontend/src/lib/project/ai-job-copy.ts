// ── AI error sanitization ───────────────────────────────────────────────
// Provider/internal AI errors can carry secrets and internal context the user
// must never see: an OpenAI 401 echoes the API key ("Incorrect API key
// provided: sk-proj-…2VAA") and the failure text can embed the full system/
// user translation PROMPT (or a role-dump like `User: …` / `Assistant: …`).
//
// ALLOWLIST MODEL (not denylist): we stopped playing whack-a-mole with leak
// SHAPES. Any text that comes from the AI PROVIDER / persisted marker error is
// only ever surfaced as (a) one of the fixed friendly CATEGORY messages
// (auth/key, quota/credits, moderation, rate-limit, network/timeout/5xx) or
// (b) a single GENERIC fallback for ANYTHING unrecognised. Provider text is
// NEVER rendered verbatim — not even redacted — so a brand-new leak shape
// (key, full prompt, `User:`/`Assistant:`/`System:` role-dump, JSON dump, …)
// can never reach the DOM. The full technical detail stays in console/server
// logs only. The secret/prompt detectors below are kept belt-and-suspenders
// for the few non-provider paths that still echo our own app errors.

// The single generic fallback shown for any unrecognised provider/marker error.
// Owner intent: "ไม่ต้องบอก prompt หรือรายละเอียดให้ user รู้ขนาดนั้น มันจะ leak".
export const AI_PROVIDER_GENERIC_ERROR = "เกิดข้อผิดพลาดกับบริการ AI (ดูบันทึกระบบ)";

// Substrings whose presence means the detail leaks an API key / secret / prompt
// and must be replaced wholesale by a generic message — never partially shown.
const SECRET_DETAIL_MARKERS = [
	"sk-",            // OpenAI / OpenRouter API keys (sk-, sk-proj-, sk-or-, ...)
	"api key",
	"api_key",
	"apikey",
	"authorization",
	"bearer ",
	"secret",
	"password",
	"token=",
	"access_token",
	"incorrect api key",
	"invalid_api_key",
	"system prompt",
	"user prompt",
	"translate this",   // leading text of the translation prompt
	"you are a",        // common system-prompt preamble
];

// Patterns that look like a credential/secret token even without a keyword.
const SECRET_PATTERNS: RegExp[] = [
	/sk-[a-z0-9-]{6,}/i,          // OpenAI-style keys
	/bearer\s+[a-z0-9._-]{8,}/i,   // bearer tokens
];

// Patterns that match a leaked-PROMPT *shape* — a generic provider/backend
// dump like `Prompt: <full prompt>` / `Input prompt: <…>` or a role-dump like
// `System: …` / `User: …`. These catch the prompt body that the keyword
// markers above miss while staying tight enough to NOT nuke a harmless short
// message that merely mentions the word "prompt". We require a colon followed
// by real content (so "prompt:" labelling actual prompt text), not the bare
// word.
const PROMPT_LEAK_PATTERNS: RegExp[] = [
	/(^|[^a-z])(input|full|request|system|user|translation|generation)\s+prompt\s*[:=]\s*\S/i,
	/(^|[^a-z])prompt\s*[:=]\s*\S/i,           // `Prompt: <content>` provider/backend dump
	/(^|[^a-z])(system|user|assistant)\s*[:=]\s*"?you are\b/i, // role-dump preamble
];

/**
 * True when a raw AI error string carries a secret (API key/token) or the
 * generation prompt and must NOT be surfaced to the user verbatim.
 */
export function aiErrorDetailLeaksInternal(detail: string): boolean {
	const lower = detail.toLowerCase();
	if (SECRET_DETAIL_MARKERS.some((marker) => lower.includes(marker))) return true;
	if (PROMPT_LEAK_PATTERNS.some((pattern) => pattern.test(detail))) return true;
	return SECRET_PATTERNS.some((pattern) => pattern.test(detail));
}

/**
 * Redact secret-shaped tokens from a string while keeping the rest readable.
 * Used as a last-resort scrub so a stray key fragment can never reach the DOM
 * even if a detail is otherwise considered safe to show.
 */
export function redactAiSecrets(detail: string): string {
	let scrubbed = detail;
	for (const pattern of SECRET_PATTERNS) {
		scrubbed = scrubbed.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`), "[ซ่อนข้อมูลลับ]");
	}
	return scrubbed;
}

/**
 * Safe, user-facing detail string for an AI error. If the raw detail leaks a
 * key/secret/prompt, callers should NOT show it — they get back the provided
 * `safeFallback` instead. Otherwise the detail is scrubbed of any stray secret
 * tokens and length-capped so we never dump an unbounded provider payload.
 */
export function sanitizeAiErrorDetail(error: unknown, safeFallback = "ไม่ทราบสาเหตุ"): string {
	const raw = rawAiErrorDetail(error);
	if (!raw) return safeFallback;
	if (aiErrorDetailLeaksInternal(raw)) return safeFallback;
	return redactAiSecrets(raw).slice(0, 200);
}

function rawAiErrorDetail(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message.trim();
	if (typeof error === "string" && error.trim()) return error.trim();
	return "";
}

// Back-compat name kept for existing callers; now returns the SANITIZED detail
// so no path can surface a raw key/prompt. The full detail is logged separately.
export function aiJobErrorDetail(error: unknown, fallback = "ไม่ทราบสาเหตุ"): string {
	return sanitizeAiErrorDetail(error, fallback);
}

/**
 * Pre-submit start failure for OUR OWN app errors (a failed save, an invalid
 * selection, etc.) raised BEFORE any provider call. These are not provider
 * payloads, so we show the safe detail (secret-scrubbed + capped belt-and-
 * suspenders) prefixed with a friendly "AI didn't start" line. A recognised
 * provider category still wins (so e.g. an early auth error never leaks the
 * key). For failures that come back FROM the provider submit call, use
 * {@link formatAiProviderStartFailure} instead — that path is allowlist-only.
 */
export function formatAiJobStartFailure(error: unknown): string {
	logAiErrorForDiagnostics("formatAiJobStartFailure", error);
	const friendly = mapKnownProviderFailure(error);
	if (friendly) return friendly;
	return `AI ยังไม่เริ่ม: ${sanitizeAiErrorDetail(error, "ลองใหม่อีกครั้ง")}`;
}

/**
 * Start failure raised BY the provider submit call (e.g. `submitAiJob` rejects).
 * This is provider text and feeds `job.error` (BatchPanel renders it verbatim),
 * so it is ALLOWLIST-only: a friendly category message or the generic fallback,
 * NEVER the raw/redacted provider detail.
 */
export function formatAiProviderStartFailure(error: unknown): string {
	logAiErrorForDiagnostics("formatAiProviderStartFailure", error);
	return resolveProviderErrorMessage(error);
}

export function formatAiJobProviderFailure(error: unknown): string {
	logAiErrorForDiagnostics("formatAiJobProviderFailure", error);
	// Provider text: ALLOWLIST only — known friendly category OR generic
	// fallback. Never the raw/redacted provider detail (it feeds job.error /
	// BatchPanel and previously leaked keys/prompts/role-dumps).
	return resolveProviderErrorMessage(error);
}

/**
 * Map provider/internal AI errors to short friendly messages WITHOUT exposing
 * raw detail. Returns null when the error isn't a recognised category, leaving
 * the caller to fall back to a sanitized detail string. Classification reads the
 * raw text (so we can still detect "sk-"/"api key"/401) but never RETURNS it.
 */
function mapKnownProviderFailure(error: unknown): string | null {
	const raw = rawAiErrorDetail(error);
	const lower = raw.toLowerCase();

	// Auth / key misconfiguration — the most sensitive case (401 echoes the key).
	if (
		lower.includes("401")
		|| lower.includes("invalid_api_key")
		|| lower.includes("incorrect api key")
		|| lower.includes("api key")
		|| lower.includes("api_key")
		|| lower.includes("unauthorized")
		|| lower.includes("authentication")
	) {
		return "บริการ AI ยังไม่พร้อม (ตั้งค่าคีย์ไม่ถูกต้อง) แจ้งผู้ดูแลระบบ";
	}
	if (lower.includes("quota") || lower.includes("insufficient_quota") || lower.includes("billing") || lower.includes("credit")) {
		return "AI ยังรันไม่ได้: เครดิตหรือโควตาไม่พอ";
	}
	if (lower.includes("moderation") || lower.includes("content_policy") || lower.includes("content policy") || lower.includes("safety")) {
		return "ภาพหรือคำสั่งนี้ติดการตรวจเนื้อหา ปรับแล้วลองใหม่อีกครั้ง";
	}
	if (lower.includes("429") || lower.includes("rate limit") || lower.includes("rate_limit")) {
		return "AI กำลังถูกใช้งานหนาแน่น รอสักครู่แล้วลองใหม่อีกครั้ง";
	}
	if (
		lower.includes("provider")
		|| lower.includes("503")
		|| lower.includes("502")
		|| lower.includes("504")
		|| lower.includes("500")
		|| lower.includes("network")
		|| lower.includes("timeout")
		|| lower.includes("timed out")
		|| lower.includes("fetch failed")
	) {
		return "สร้างภาพ AI ไม่สำเร็จ ลองใหม่อีกครั้ง";
	}
	return null;
}

/**
 * ALLOWLIST resolver for any PROVIDER / persisted-marker AI error string.
 *
 * Returns EXACTLY one of:
 *   (a) a fixed friendly CATEGORY message (auth/key, quota/credits, moderation,
 *       rate-limit, network/timeout/5xx) when the raw text matches a known
 *       provider-failure category, or
 *   (b) the single GENERIC fallback (`AI_PROVIDER_GENERIC_ERROR`) for ANYTHING
 *       else — including a raw key, a full prompt, a `User:`/`Assistant:`/
 *       `System:` role-dump, a JSON blob, or random `foobar`.
 *
 * It NEVER returns the raw/redacted provider text. This is the decisive change
 * that kills the entire leak class without enumerating shapes: unrecognised
 * detail → generic message, full detail to logs only. Empty input returns the
 * provided `emptyFallback` (default: the generic message) so a caller can opt
 * into "" for the needs_review path.
 */
function resolveProviderErrorMessage(error: unknown, emptyFallback = AI_PROVIDER_GENERIC_ERROR): string {
	const raw = rawAiErrorDetail(error);
	if (!raw) return emptyFallback;
	const friendly = mapKnownProviderFailure(raw);
	if (friendly) return friendly;
	// Unrecognised → generic. We do NOT surface raw or redacted provider text.
	return AI_PROVIDER_GENERIC_ERROR;
}

/**
 * Log the FULL technical detail to the console for diagnostics. This is the only
 * place the raw key/prompt-bearing string is allowed to live; it must never be
 * returned into UI copy.
 */
function logAiErrorForDiagnostics(scope: string, error: unknown): void {
	// eslint-disable-next-line no-console
	console.error(`[AI:${scope}]`, error);
}

export function formatAiMissingResultFailure(): string {
	return "AI จบงานแล้วแต่ไม่มีรูปผลลัพธ์";
}

/**
 * Friendly copy for a job/marker that the backend flagged as needs_review
 * (moderation). Sanitizes the provider/moderation detail so no key/prompt
 * leaks if the backend ever embeds one in the review reason.
 */
export function formatAiNeedsReviewStatus(error: unknown): string {
	// Provider/moderation text: ALLOWLIST only. An empty reason → the friendly
	// "needs review" line; any recognised category → its friendly message; any
	// unrecognised reason → the generic fallback (NEVER the raw review reason,
	// which could embed a key/prompt the backend echoed).
	return resolveProviderErrorMessage(error, "คำสั่งนี้ต้องตรวจเนื้อหาก่อนรัน AI");
}

/**
 * Sanitized version of a STORED marker error for display. Markers loaded from
 * the backend can carry the raw provider failure (which may echo the API key
 * or prompt), so every place that renders `marker.error` must funnel through
 * here. Returns "" when there is nothing safe to show.
 */
export function sanitizeAiMarkerError(error: string | null | undefined): string {
	if (!error || !error.trim()) return "";
	// Stored marker error = provider text. ALLOWLIST only: known friendly
	// category OR generic fallback. We NEVER return the raw/redacted marker
	// text, so no leak SHAPE (key, prompt, `User:`/`Assistant:` role-dump,
	// JSON, future shapes) can ever render. Empty handled above.
	return resolveProviderErrorMessage(error.trim());
}

/**
 * Friendly, ALWAYS-SANITIZED copy for a (possibly persisted) AI error string
 * shown inline in queue/focus surfaces. This is the root for every UI that wants
 * a short "AI failed" line from a marker/job error: it funnels the raw text
 * through `sanitizeAiMarkerError()` (which maps known provider failures, drops
 * key/prompt-bearing detail, and scrubs stray secret tokens) so NO caller can
 * ever emit a raw API key or prompt — even the OpenAI 401 body
 * ("Incorrect API key provided: sk-proj-…2VAA") that the old weak filter missed.
 * Empty/whitespace input falls back to a friendly recovery line, and any safe
 * detail is length-capped so we never dump an unbounded provider payload.
 */
export function aiErrorCopy(
	error: string | null | undefined,
	emptyFallback = "รัน AI ไม่สำเร็จ เพิ่มโน้ตแก้หรือขอรันใหม่",
): string {
	const safe = sanitizeAiMarkerError(error);
	if (!safe) return emptyFallback;
	return safe.length <= 120 ? safe : `${safe.slice(0, 117)}...`;
}

export function formatAiCancelledStatus(error: unknown): string {
	return `AI ถูกยกเลิก: ${aiJobErrorDetail(error, "ยกเลิกแล้ว")}`;
}

export function formatAiCancelBackendFailed(error: unknown): string {
	return `ยกเลิก AI ฝั่ง backend ไม่สำเร็จ: ${aiJobErrorDetail(error, "ติดต่อ backend ไม่สำเร็จ")}`;
}

export function formatAiStatusRetry(attempt: number, maxAttempts: number): string {
	return `เช็กสถานะ AI สะดุด กำลังลองใหม่ ${attempt}/${maxAttempts}`;
}

export function formatAiStatusRetryDetail(error: unknown, attempt: number, maxAttempts: number): string {
	return `เช็กสถานะ AI สะดุด (${attempt}/${maxAttempts}): ${aiJobErrorDetail(error, "รอบเช็กสถานะล้มเหลว")}`;
}

export function formatAiStatusFailed(error: unknown): string {
	return `เช็กสถานะ AI ไม่สำเร็จ: ${aiJobErrorDetail(error, "รอบเช็กสถานะล้มเหลว")}`;
}

export function formatAiAutoApplyFailed(error: unknown): string {
	return `AI สร้างรูปแล้ว แต่ใส่ลงหน้าไม่สำเร็จ: ${aiJobErrorDetail(error, "ใส่รูปผลลัพธ์ลงหน้าไม่สำเร็จ")}`;
}

export function formatAiMarkerCreatePending(): string {
	return "AI กำลังทำงาน แต่ยังสร้างรายการผล AI ไม่สำเร็จ";
}

export function formatAiCoverSelectionRequired(): string {
	return "ลาก selection ด้วยเครื่องมือ AI Cover ก่อนรัน";
}

export function formatAiMarkerRerunNoProject(): string {
	return "เปิดงานก่อนรันผล AI อีกครั้ง";
}

export function formatAiMarkerRerunPageMissing(pageNumber: number): string {
	return `ไม่พบหน้า ${pageNumber} สำหรับรัน AI อีกครั้ง`;
}

export function formatAiMarkerRerunStaleImage(): string {
	return "ผล AI นี้ผูกกับรูปเวอร์ชันเก่า; เปิดรูปหน้าที่ตรงกันหรือรันพื้นที่ใหม่อีกครั้ง";
}

export function formatAiMarkerRerunWrongPage(pageNumber: number): string {
	return `เปิดหน้า ${pageNumber} ก่อนรันผล AI นี้อีกครั้ง`;
}

export function formatAiMarkerRerunRegionTooSmall(): string {
	return "พื้นที่ผล AI เล็กเกินไปสำหรับรันอีกครั้ง";
}

export function formatAiMarkerRerunQueued(pageNumber: number): string {
	return `ส่งคำขอรัน AI หน้า ${pageNumber} เข้าคิวแล้ว`;
}
